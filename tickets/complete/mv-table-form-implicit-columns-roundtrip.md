description: COMPLETE — the live-exec channel of `create table … maintained [(columns)] as` now honors the rename-list clause as the single source of truth for `derivation.columns` (implicit ⇒ undefined/reshape, explicit ⇒ declared names/arity-lock, mismatched ⇒ sited error), so live exec and catalog import of the same canonical DDL agree on both the record and the bodyHash. Reviewed; all findings minor or non-issues; no inline fixes or new tickets required.
files:
  - packages/quereus/src/parser/parser.ts                            # parseMaintainedClause — empty `maintained () as` list rejected
  - packages/quereus/src/planner/building/ddl.ts                     # raiseCreateMaintainedDiagnostics + raiseMaintainedColumnListDiagnostics (build-time arity + positional name match)
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts   # describeAttachShapeMismatch(skipNames), attachMaintainedDerivation(recordedColumns, positionalRename), createMaintainedTable
  - packages/quereus/src/runtime/emit/alter-table.ts                 # runSetMaintained — attach verb passes declared names explicitly (unchanged behavior)
  - packages/quereus/test/maintained-table-attach-detach.spec.ts     # 'live-exec table-form authored columns' block (8 tests)
  - packages/quereus/test/view-mv-ddl-persistence.spec.ts            # 'table-form authored' fixed-point matrix (3 rows)
  - packages/quereus-store/test/mv-rehydrate-adopt.spec.ts           # table-form implicit reshape-on-reopen test
  - docs/materialized-views.md                                       # § CREATE TABLE … MAINTAINED AS — "The maintained (columns) rename list" subsection
difficulty: medium
----

# Complete: table-form maintained DDL live-exec honors the `maintained (columns)` clause

The `maintained [(columns)]` clause is now the single source of truth for
`derivation.columns` on the live-create channel, matching what catalog persist +
import already did. Presence of the list is the lossless implicit/explicit signal:
omitted ⇒ `derivation.columns = undefined` (clause-free canonical DDL, `select *`
reshapes its source on reopen); present ⇒ declared names recorded (arity-locked, a
widened source between sessions is a sited error). A wrong-arity / mis-named /
empty list is a sited error, never a silent drop. Live exec and catalog import of
the same canonical DDL therefore agree on both the record and the `bodyHash`,
making live-create → persist → reopen → re-persist a byte-identical fixed point.

The implement stage's handoff is accurate. The deviation it flagged (splitting the
plan's single `explicitColumns` parameter into `recordedColumns` +
`positionalRename`) is the correct call: the three behaviors required —
strict-name + declared-names (attach verb), strict-name + undefined (implicit
create), skipped-name + declared-names (explicit create) — genuinely cannot be
expressed by one presence-keyed parameter without either re-breaking gap 1 or
making the attach verb lenient (which the plan explicitly parked in backlog ticket
`maintained-table-reattach-columns-parity-and-reshape`). The reviewer concurs the
attach verb should stay strict, and that this is intent-driven (no test pins a
name-mismatch on the attach verb).

## Review findings

### Verified correct (checked, no issue)

- **No bypass of the build-time gate.** `raiseMaintainedColumnListDiagnostics` is
  reached only via `raiseCreateMaintainedDiagnostics` ← `buildCreateTableStmt`,
  and the sole emit path to `createMaintainedTable` is `CreateTableNode` emit,
  which can only exist for a node built by `buildCreateTableStmt`. So a
  mismatched/wrong-arity list can never reach the lenient positional-rename
  emitter without first being rejected at build. Confirmed by reading the call
  graph (`grep` for both symbols across `src/`).
- **Single source of truth holds end-to-end.** The import path
  (`maintainedImportFromTableStmt`, manager.ts:142) recovers `columns` from
  `maintained.columns` (the clause), never from the declared column list, and
  `buildTableDerivation` hashes `def.columns` into `bodyHash` via
  `viewDefinitionToCanonicalString`. So implicit (undefined) and explicit
  (declared casing) both agree across live-exec and import — the new tests pin the
  `bodyHash` equality directly.
- **Differ handles BOTH authoring forms.** `maintainedBodyMatches`
  (schema-differ.ts:1910) compares `declared.columns` as-authored, with the
  live-names fallback gated to the implicit (`columns === undefined`) form only.
  The sugar/implicit form routes through computeTableAlterDiff's early arm
  (line 1624); the table-form-with-declared-columns form falls through to the full
  comparison and still reaches `applyMaintainedTransition` (line 1822). So
  declare-schema idempotence — which the implementer flagged as only transitively
  covered — is structurally sound, not just incidentally green.
- **Casing.** Build-time name check is case-insensitive; `recordedColumns` is
  taken from the declared columns (declared casing); the generator emits the
  clause from `derivation.columns`, so import re-parses the same casing. Test t7
  (`maintained (ID, V)` on `("id","v")`) pins the recorded declared casing.
- **Implicit form rejects a rename-without-list.** Manually verified
  `create table mv (key_id, val) maintained as select id, v from src` errors
  "body output column 1 is named 'id' but the table declares 'key_id'" and
  registers nothing — the contract that renaming requires the explicit list. This
  was not in the implementer's test set (it is existing strict-check behavior) but
  is the natural complement to gap 2; confirmed by an ad-hoc probe.
- **Type safety / lint.** No `any` introduced; `recordedColumns:
  ReadonlyArray<string> | undefined`, `positionalRename = false`. `eslint` and
  `tsc --noEmit` both clean.
- **Docs.** `docs/materialized-views.md` § CREATE TABLE … MAINTAINED AS gained an
  accurate implicit-vs-explicit subsection; `docs/sql.md:1497` already described
  the `maintained [(columns)]` clause consistently (no drift). No other doc
  describes the pre-fix (clause-dropping) behavior.

### Minor (noted, left as-is — not worth a behavior-changing edit)

- **Redundant double shape-check** in `createMaintainedTable`: the early gate
  (lines 981–991) and the attach core both run `describeAttachShapeMismatch`, now
  both threading the `explicit`/`skipNames` flag. Kept consistent by hand. The
  early gate is a legitimate optimization (it yields a *sited* diagnostic with
  line/column and avoids a create-then-drop round-trip), so collapsing it would
  regress diagnostics or add churn. Left as documented by the implementer; the
  drift risk is real but low (one boolean threaded to both).
- **Dead defensive sub-condition** `list.length > 0` in `explicit = list !==
  undefined && list.length > 0`: the parser now rejects empty lists, so `list` is
  undefined or non-empty and the length check is always true when defined.
  Harmless; reads as intentional belt-and-suspenders. Left in place.
- **`recordedColumns` source asymmetry**: the early check derives names from
  `sm.buildDeclaredTableSchema(stmt)` while attach records
  `table.columns.map(c => c.name)` from `sm.createTable(stmt)`. Both derive from
  the same `stmt.columns`, so they are identical in practice; and only the attach
  value is *recorded*, so even a hypothetical divergence cannot corrupt the record.
  No action.

### Pre-existing (out of scope, not introduced here)

- `createMaintainedTable`'s cleanup `catch { /* best-effort cleanup */ }` swallows
  a `dropTable` failure without logging (against AGENTS.md "don't eat exceptions
  w/o logging"). This try/catch predates this ticket (context lines in the diff)
  and the original create error is still rethrown. Not addressed here.
- The create path derives the body shape twice (early gate + attach core). This is
  pre-existing for every create form (implicit and explicit alike) — no new
  per-statement cost was introduced.

### Coverage gaps (accepted; consistent with the implementer's honesty)

- **Coarsened-key + positional-rename combo** not unit-tested. Under
  `positionalRename`, `CoarsenedKeyInfo.columns` reports declared names rather than
  the body's natural names (more correct). Low risk; no rename+coarsened fixture
  added. Filed nothing — flag for a future hardening pass if desired.
- **No backwards-compat for pre-fix backings.** A backing persisted by a *pre-fix*
  session carries `maintained (id, v)` for what is now implicit and reopens
  arity-locked. Accepted per project rules (no backwards-compat yet); the POST-fix
  fixed point holds from the first persist. No migration written or expected.
- **Explicit arity-lock-on-reopen** is covered transitively by the shared import
  arity gate (`assertDeclaredColumnArity`, pinned by the store suite's
  declared-column-arity-mismatch tests) and the gap-2 `bodyHash`/record agreement
  test, not by a dedicated explicit-form store reshape-rejection twin.

### Validation run (all green)

- `packages/quereus`: `eslint` clean; `tsc --noEmit` clean. Targeted specs
  `maintained-table-attach-detach.spec.ts` + `view-mv-ddl-persistence.spec.ts`:
  **80 passing**.
- `packages/quereus-store`: `mv-rehydrate-adopt.spec.ts`: **22 passing** (against a
  current `dist`, confirmed to contain the new `skipNames`/`positionalRename`/
  `recordedColumns` code). The logged "Failed to rehydrate DDL entry" / "Data
  change listener error" lines are deliberate negative-path test output, not
  failures.
- Did NOT run `yarn test:store` (full LevelDB re-run) or `test:full` — out of
  scope per the plan ticket's "run quereus test, lint, store test"; the modified
  store spec was run directly instead.

## Disposition

No major findings → no new fix/plan/backlog tickets filed. No minor findings
warranted an inline behavior change (the two cleanup candidates would regress
diagnostics or remove a harmless guard). Implementation accepted as-is.
