description: COMPLETE — `alter table … set maintained (cols) as <body>` explicit rename-list verb plus the attach-core behavior (explicit-target reshape, list/body arity guard, and the reshape-gate relaxation that lets a bare re-attach over a prior-explicit record "go implicit"). Reviewed; build + lint + full memory suite green; three test gaps closed inline.
prereq:
files:
  - packages/quereus/src/parser/parser.ts                            # parseMaintainedColumnList helper + SET MAINTAINED (cols) parse
  - packages/quereus/src/parser/ast.ts                               # setMaintained action: columns?
  - packages/quereus/src/emit/ast-stringify.ts                       # alterTable setMaintained renders (cols) when present
  - packages/quereus/src/planner/nodes/alter-table-node.ts           # setMaintained action columns? + toString
  - packages/quereus/src/planner/building/alter-table.ts             # thread columns into the node
  - packages/quereus/src/runtime/emit/alter-table.ts                 # dispatch + runSetMaintained threads columns
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts   # attachMaintainedDerivation gate rewrite + arity guard + explicit-name-drift reshape
  - packages/quereus/test/maintained-table-attach-detach.spec.ts     # "explicit rename-list re-attach" block (+3 review pins)
  - packages/quereus/test/declarative-equivalence.spec.ts            # rewrote sugar-MV rename-list test (goes-implicit / explicit-verb converges)
  - packages/quereus/test/logic/51.7-maintained-table-attach-detach.sqllogic  # section 12
  - docs/materialized-views.md                                       # SET MAINTAINED AS (cols), Reshape-on-attach, declarative-integration bullet
----

# COMPLETE: `set maintained (cols) as` — explicit rename-list re-attach + backing reshape

## What landed (as implemented)

Grammar `alter table X set maintained [(col, …)] as <body> [insert defaults (…)]`, plus the
attach-core behavior giving the rename list meaning:

- **Plumbing** — shared `parseMaintainedColumnList` parser helper, AST `columns?`, ast-stringify
  renders `(cols)` only when present (byte-identical bare form otherwise), plan-node action +
  `toString`, builder threads `columns`, `runSetMaintained` maps `columns` →
  `recordedColumns`/`positionalRename`.
- **Attach core** (`attachMaintainedDerivation`):
  - *Explicit-target reshape* — a same-arity output-NAME drift `(a,b)→(a,c)` produces no strict
    mismatch (names skipped under `positionalRename`), so it is classified as a reshape: the
    derived shape carries the TARGET names, `classifyBackingReshape` emits a pure positional
    RENAME, a renamed PK output column is matched through the rename map (not a key change), a
    reorder/swap is inexpressible.
  - *List/body arity guard* — `recordedColumns.length !== shape.columns.length` throws a sited
    error before anything is recorded (`deriveBackingShape` sizes to the body, so a miscounted
    list would otherwise persist).
  - *Gate relaxation* — a bare implicit `set maintained as` over a prior-explicit record no longer
    errors; it reshapes the backing to the body's natural names and records implicit ("go implicit").
- **Differ deliberately NOT updated** — `schema-differ.ts` still emits `setMaintained` without
  `columns`; that is the sibling ticket `maintained-reattach-explicit-rename-list-reshape`.

## Validation

- `yarn build` — clean (all packages).
- `yarn lint` (eslint + `tsconfig.test.json` typecheck) — clean, exit 0.
- Full memory suite (`node test-runner.mjs`) — **6178 passing, 0 failing, 9 pending** (baseline
  6176 + 2 new review pins).
- `51.7` §12 sqllogic — passes.

## Review findings

Adversarial pass over the implement diff (bcd02734). Scrutinized: gate-relaxation correctness,
the two reshape triggers, the arity guard, resource/rollback handling, type safety, docs accuracy,
and test coverage (happy path, edge, error, regression, interactions).

### Correctness — checked, no defects

- **Gate logic.** Traced `attachMaintainedDerivation` end-to-end. `strictMismatchReshape` /
  `explicitNameDriftReshape` partition cleanly: the explicit-drift branch is only reached when
  `mismatch === null` (so `table.columns.length === shape.columns.length`), making the
  positional `shape.columns[i]` access safe. Confirmed via `describeAttachShapeMismatch` that
  `skipNames` still enforces count/type/not-null/collation/PK — so an attribute or PK delta on
  the explicit path is correctly routed to the strict throw rather than silently reshaped.
- **Arity guard.** Confirmed against `deriveBackingShape` (`deriveBackingShapeUnguarded`): the
  shape is sized to the BODY (`bodyColumns.map`, surplus rename names dropped, missing ones
  padded `col${i}`), so the `recordedColumns.length !== shape.columns.length` guard is the real
  safety net and fires before any catalog mutation. The CREATE path's own table-vs-body check
  keeps create unaffected.
- **Rollback / resource cleanup.** The two-phase splice (`restorePrior` / `restoreReshaped`,
  eager-commit before data-validating attribute ops, per-op catalog re-register) is unchanged by
  this ticket and reused; the explicit path rides the identical machinery. Inexpressible/strict
  errors leave the table untouched (verified by the swap and count-drift pins, incl. bodyHash
  restore).
- **Idempotency.** Re-running an explicit verb after its reshape sees matching names → no drift →
  plain reconcile. Pinned.

### Findings fixed inline (minor)

- **Misleading test rewritten.** `"the explicit verb round-trips: ast-stringify emits the (cols)
  clause"` asserted only `derivation.columns` — it never exercised `astToString`. Because the
  differ does not emit `columns`, the new `(cols)` branch of `alterTableToString` had **zero**
  coverage. Rewrote to parse→stringify→reparse the explicit verb (asserts the `(a, c)` render and
  stringify stability) and to confirm the bare form renders no parenthesized list.
- **Gap pin: explicit rename + concurrent type change** (ticket flagged as not pinned). Added a
  test: `(a,b)→(a,c)` where `c`'s body output is INTEGER over a TEXT column → strict shape error,
  table untouched. Behaves as designed (the explicit path reshapes a pure NAME drift only).
- **Gap pin: explicit rename-list attach to a PLAIN table** (ticket flagged as not pinned). Added
  a test: `set maintained (a, b) as` over `plain(c, d)` renames c→a, d→b and reconciles the plain
  rows against the derived content (derived wins). Behaves as designed.

### Findings deferred (not defects — documented)

- **`yarn test:store` (store backing host).** Deferred per ticket guidance — slow / not
  agent-runnable inside the 10-minute idle budget. The explicit reshape rides the same
  `module.alterTable` rename ops + eager-commit discipline the implicit reshape already exercised
  under the store-parity ticket, so risk is low, but the store path's committed-vs-pending
  validation under the explicit RENAME is **not** verified in-ticket. Run out-of-band / in CI
  before a release.
- **`insert defaults` referencing a renamed/dropped column.** Genuinely out of scope here:
  `runSetMaintained` records `insertDefaults` verbatim and does not crash. The latent
  rename-vs-default interaction is tracked for the implicit path by the sibling reshape ticket;
  no new behavior in this ticket introduces it, so no pin added.

### Behavior changes confirmed intentional

- `maintained-table-attach-detach.spec.ts` #607 — was "explicit never reshapes / strict error";
  now "bare verb goes implicit". Matches the documented gate-relaxation semantics.
- `declarative-equivalence.spec.ts` (~1407) — was "rename-list change errors at apply"; now
  "apply succeeds by going implicit but does NOT converge in one diff until the differ ticket; the
  explicit verb converges when applied manually". This honestly reflects the scoping (differ
  deferred to `maintained-reattach-explicit-rename-list-reshape`) and the docs do not over-promise
  convergence.

### No major findings → no new tickets filed.

The differ scoping and the store-parity follow-up are both already tracked
(`maintained-reattach-explicit-rename-list-reshape`); nothing in this review uncovered work
warranting a new fix/plan/backlog ticket.
