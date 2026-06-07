description: |
  Enforce single-member-resolvable lens obligations (row-local CHECK, child-side FK,
  commit-time set-level uniqueness) on the decomposition (multi-member primary-storage)
  INSERT path. Previously `buildDecompositionMemberInsert` built each member insert with
  NO extra constraints (hard-coded `[]`), so a lens-synthesized logical CHECK that one
  base member fully resolves never fired on an INSERT through the logical view — even
  though the UPDATE path and the single-source INSERT path both enforced it. The fix
  threads the same `constraintsForOp` per-op resolvability gate the decomposition UPDATE
  path uses onto the INSERT member fan-out, collecting the three INSERT-applicable lens
  constraint classes and tracing any cross-member obligation that rides no member op.
  Cross-member obligations stay DEFERRED (the documented, deliberately-weaker contract).
files:
  - packages/quereus/src/planner/building/view-mutation-builder.ts  # buildDecompositionInsert, buildDecompositionMemberInsert, constraintsForOp, rejectLensSetLevelConflictResolution
  - packages/quereus/test/lens-put-fanout.spec.ts                   # setupSurrogateWithChecks cluster — 5 INSERT cases + parity
  - docs/lens.md                                                    # § Enforcement by constraint class (L286, L291)
----

## Summary of implemented work (reviewed)

`buildDecompositionInsert` now collects `lensRowLocalConstraints` / `lensForeignKeyConstraints`
/ `lensSetLevelConstraints` (parent-side FK deliberately NOT collected — an INSERT cannot orphan
a child), gates each per member op via `constraintsForOp(op, extraConstraints, ridden)` reusing
one `ridden` set across all member ops, threads the gated subset through
`buildDecompositionMemberInsert` → `buildInsertStmt`'s `extraConstraints` seam (replacing the old
hard-coded `[]`), and runs the cross-member trace loop — a faithful mirror of the UPDATE fan-out
in `buildViewMutation`. `constraintsForOp`'s `op` param was widened from `BaseOp` to
`Pick<BaseOp, 'table'>` so a `DecompInsertOp` satisfies it structurally (both carry a
`TableReferenceNode` exposing `tableSchema.columns`). A `rejectLensSetLevelConflictResolution`
call was added at the top of `buildDecompositionInsert` because that path early-returns from
`buildViewMutation` before the main gate, and the path now threads the commit-time set-level count
CHECK — so an `insert or replace`/`or ignore`/upsert must be rejected up front rather than
silently ABORTing at commit. `lensRouted` stays `false` (unchanged, deliberate). Docs §286/§291
were reconciled.

## Review findings

Adversarial pass over commit `0d538f45`. Read the implement diff (source + docs + tests) with
fresh eyes before the handoff summary, then probed correctness, type safety, parity, docs, and
coverage.

### Checked — and clean

- **UPDATE/INSERT parity.** The INSERT gate (`constraintsForOp` + shared `ridden` set + trace
  loop) is a faithful structural mirror of the UPDATE/DELETE fan-out in `buildViewMutation`
  (lines 188–202 vs 612–631). Same seam, same gate, same deferral semantics. No divergence.
- **Type safety.** The `Pick<BaseOp, 'table'>` widening is sound: `DecompInsertOp.table` is a
  `TableReferenceNode` carrying `tableSchema.columns`, so `op.table.tableSchema.columns` resolves
  the member's full schema for either op shape. `tsc` build **and** `--noEmit` typecheck both exit 0.
- **`rejectLensSetLevelConflictResolution` placement.** Verified by reading `buildViewMutation`'s
  routing order: the decomposition-insert early-return (line 69) sits *above* the main gate (line
  96), so the gate genuinely must be re-run in `buildDecompositionInsert`. The `{ op: 'insert',
  stmt }` literal is type-safe (`tags` is optional on `MutationRequest`). The gate fires before
  `analyzeDecompositionInsert` (fail-fast). Pinned by the new `insert or replace` rejection test.
- **Constraint-class collection.** Row-local / child-FK / set-level collected; parent-side FK
  correctly omitted on INSERT (cannot orphan a child) — matches docs.
- **Per-op gate semantics.** Single-member CHECK rides its member and fires; cross-member CHECK
  rides none and defers; set-level count CHECK rides only the key-owning anchor (Doc_core) and
  auto-defers to commit. Presence-gated optional members compose correctly with the gate (an
  absent optional member inserts no row, so its column's CHECK never fires for that row — correct).
- **Double-enforcement on a shared key-name across members** is redundant-but-sound (a count CHECK
  riding every member of a logical-tuple decomposition defers identically on each), matching the
  UPDATE path. Documented, acceptable.
- **Docs.** `docs/lens.md` §286/§291 read accurately and consistently with the implemented gate.
- **Regression sweep.** `lens-put-fanout.spec.ts` 71 passing; all `lens-*.spec.ts` 379 passing;
  `mutation-context` + `view-tag-mutation-plan` + `view-mutation-substrate` 11 passing. Lint exit 0.

### Found and fixed (minor)

- **Stale test comment** (`lens-put-fanout.spec.ts:1578`). The UPDATE-fixture comment block still
  claimed the decomposition INSERT path "defers all lens row-local checks" — false post-ticket: it
  now runs the *same* per-op gate, enforcing single-member checks and deferring only cross-member
  ones. Rewritten to state that accurately. (Comment-only; no lint/test impact.)

### Probed, documented, not actioned (no ticket)

- **Defaulted-but-CHECK-referenced column.** Attempted a dedicated test on the existing surrogate
  fixture (INSERT omitting `title`, which `length(title) < 5` references). It surfaced that
  `assertNoMissingNotNull` in `analyzeDecompositionInsert` (`decomposition.ts:335`) **rejects
  omitting `title`** for this decomposition *before* the CHECK gate is even reached — so the
  fixture cannot exercise the defaulted-column path, exactly as the implementer flagged. The path
  is sound by design (the gate keys off `op.table.tableSchema.columns` — the member's full schema,
  not the supplied subset — and the member insert runs the ordinary `buildInsertStmt`
  default+constraint pipeline that exposes the full NEW row to checks, the same pipeline the
  *covered* single-source insert spine uses). Pinning a *violating* default would require a new
  fixture with a member column carrying a non-null default referenced by a CHECK — low value
  relative to churn; not worth a ticket. Test attempt reverted.
- **Child-side FK on decomposition INSERT** is collected and gated identically to the row-local
  class, threaded through the same `buildInsertStmt` `extraConstraints` seam the single-source
  insert spine exercises for FK elsewhere. Low risk; the surrogate fixture declares no logical FK,
  so it is not empirically pinned on this path. Documented, not ticketed.
- **DRY of the trace loop.** The 4-line "unridden ⇒ log" loop now appears at two call sites with
  context-specific wording ("base op of the %s fan-out" vs "member op of the decomposition insert
  fan-out"). Extracting a helper would parameterize only the message string; judged not worth the
  churn in a reviewed builder. Noted.
- **Multi-source-join INSERT** still bypasses `rejectLensSetLevelConflictResolution` AND threads no
  set-level constraints — a pre-existing, deliberately-untouched gap (not a regression here), as
  the implementer flagged.

### Major findings

None. No new fix/plan/backlog tickets filed.

## Validation

- `node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js "packages/quereus/test/lens-put-fanout.spec.ts"` → **71 passing**
- All `lens-*.spec.ts` → **379 passing**; mutation/view-substrate specs → **11 passing**
- `yarn workspace @quereus/quereus run lint` → exit 0
- `yarn workspace @quereus/quereus run build` (tsc) and `run typecheck` (tsc --noEmit) → exit 0
