description: Applying a declared schema now refuses, before running anything, any change that drops a table, drops a column, changes a column's type or moves a table to another storage module, unless the user passes allow_destructive. Review the gate, its error message, and the existing tests that were updated to acknowledge their intentional drops.
architecture: docs/schema-declarative.md#declarative-schema
files:
  - packages/quereus/src/schema/schema-differ.ts              # DestroyedData type, MigrationStep.destroys, StepUndo widened, UndoRenderer.droppedTable / droppedColumn / retypedColumn
  - packages/quereus/src/runtime/emit/schema-declarative.ts   # emitApplySchema reorder, refuseUnacknowledgedDataLoss, dataLossRefusal, refusalPart
  - packages/quereus/test/logic/50-declarative-schema.sqllogic # new "destr_gate" block, plus acknowledged applies
  - docs/schema-declarative.md
  - docs/sql-ddl.md
  - docs/schema-undo-plan.md
  - docs/todo.md
----
# Review: gate every data-destroying `apply schema` step on `allow_destructive`

## What changed

**Representation (`schema-differ.ts`).** New exported type `DestroyedData` (`{kind: 'table', table}` or `{kind: 'column' | 'retype', table, column}`) and a new optional `MigrationStep.destroys`. Only the three `UndoRenderer` arms that discard stored data set it, alongside their existing `irreversible` text: `droppedTable`, `droppedColumn` and `retypedColumn`. An `irreversible` from `cannotUndo` (a catalog entry lacking what its restore needs) carries no `destroys`, so the gate ignores it. `MigrationStep` is not exported from `src/index.ts`, so `DestroyedData` is exported only from `schema-differ.ts`, next to `MigrationStep`.

**Side fix in `droppedTable`.** It used `this.tables.has(name)` (a pre-apply name lookup) where every other arm uses `tableNow` (lookup through the renames in force, Rule 1 of `MigrationStep`). A module move that also renames the table drops it under its new name (the rename runs first), so the old lookup classified that drop as `NOTHING_TO_UNDO`. It destroys rows, and on a later failure the unwind would have tried `ALTER TABLE new RENAME TO old` on a table that no longer exists. It now uses `tableNow`, so the drop is `irreversible` + `destroys`. I checked this with a throwaway probe (rename `a`→`b` + move `memory`→`mem2`: the plan's `DROP TABLE IF EXISTS b` now carries `destroys`, and the refusal lists `'b'` once, as a move). I added no test for it.

**Gate (`emitApplySchema`).** Order is now: `computeSchemaDiff` → `generateMigrationPlan` (moved up) → `refuseUnacknowledgedDataLoss` unless `allowDestructive` → `refuseModuleMoveLeavingDanglingRows` → rebuild refusal and loop (unchanged). The gate throws `QuereusError(ERROR)` before `beginSchemaBatch`, so no DDL, hook or event happens. It fires when any step has `destroys` **or** `diff.moduleMigrations` is non-empty. I kept the second trigger so a module move stays gated even if its drop step were ever misclassified. The old `moduleMigrationRefusal` is gone.

Message (parts appear only when non-empty, in this order):

```
apply schema '<schema>': this migration destroys stored data: table(s) 'a' would be dropped with their rows; column(s) 't.c' would be dropped with their values; column(s) 't.d' would change type, which can lose values; table(s) 'x' (memory → mem2) would be moved to another module by dropping and recreating them empty — their rows are lost; maintained table(s) 'mv' (memory → mem2) would be moved to another module by dropping and re-materializing them as a new incarnation. Re-run with options (allow_destructive = true) to migrate. A renamed table or column keeps its data only with a rename hint (the quereus.previous_name tag).
```

The last sentence appears only when a table or column drop (not a retype or a move) is listed. A module move's own `DROP TABLE` is left out of the "dropped" list by matching `diff.moduleMigrations` names case-insensitively. The ticket suggested also matching through `diff.renames`, but the differ always drops a renamed-and-moved table under its declared name, so that lookup was dead code and I removed it. The comment on `dataLossRefusal` says why.

## Test added

- `50-declarative-schema.sqllogic`, block "A plan that destroys stored data …" (schema `destr_gate`). One unacknowledged apply has a dropped table, a dropped column and a retyped column, and the `-- error:` text pins all three parts in order. Selects then show nothing ran. The acknowledged apply then succeeds: `gone` is not found, and `keep.b` is converted `'7'` → `7`.

## Existing tests changed (no assertion weakened)

Each of these intentionally destroys data and now passes `options (allow_destructive = true)`. Some are shared helpers: `applies` in `apply-schema-alter-order.spec.ts`, `declareAndApply` in `declarative-upgrade-equivalence.spec.ts`, and the drift-reconcile loop in `apply-schema-unchanged-fast-path.spec.ts`. Others are single sites: `apply-schema-index-order`, `apply-schema-restore` (6 sites, including two `expectRefused(...)` calls that now pass the flagged apply), `assertion-body-resolves`, `ddl-schema-event-atomicity`, `maintained-table-differ-coverage` (2), `maintained-table-migration-capstone` (contract step, which confirms a maintained table's drop is gated: `UndoRenderer.tables` does hold maintained tables), `schema-batch-hook` (`refusedApply` gained an optional statement argument), `quereus-sync/test/sync/schema-alter-replication.spec.ts`. In sqllogic: `41.15` (2), `50` (16), `50.1` (1), `50.2` (1, combined with `rename_policy = 'deny'`), and `50.4` (10, including the drop-guard refusals `cannot drop table … reaches it through view`, which now need the flag to be reached).

**One test changed differently.** `10.5.7-implicit-unique-index-lifecycle.sqllogic` § 12 says it "runs … against an otherwise-empty main schema, so … the diff generates no drops". That was false: `reuse_pt`, `iul_m`, `iul_n`, `iul_o` and `iul_p` were still around, and the gate reported them. I added `drop table` for those five before § 12, so the comment is now true. I did not add the flag there. The reviewer may prefer the flag instead.

## Validation run

- `node … mocha "packages/quereus/test/**/*.spec.ts" --reporter spec`: 11186 passing, 0 failing (35 failed before the test updates).
- `yarn workspace @quereus/quereus run lint` (eslint + test type-check): clean.
- `yarn build`, then `yarn workspaces foreach -A --exclude quereus-workspace --exclude @quereus/quereus run test`: all green, after the one sync fix.
- `yarn test:store`: 11179 passing, 0 failing.

## Things for the reviewer to check

- **Error ordering.** An unacknowledged module move with dangling child rows now reports the acknowledgement refusal first. Two `50-declarative-schema.sqllogic` cases expecting `still has rows referencing it` now send the flag to reach that error.
- **Bundle importer** (`packages/quereus-bundle/src/import-schema.ts`) was not changed. Its own destructive check is a superset of this gate, and its tests passed.
- **`docs/sql-ddl.md`.** The Safety section was rewritten: a general rule with a dropped-column example, and module moves as one gated case with the new message. Both stale seed statements ("clears existing data") were corrected to describe `ON CONFLICT (pk) DO NOTHING`. `docs/todo.md` now marks the gate item done.
- **Known gap.** No test pins the rename + module-move de-duplication or the `droppedTable` → `tableNow` reclassification. I verified both only with the probe described above.
- `diff schema` is unchanged (ungated, one `ddl` column). Marking destructive rows in the preview is parked in `backlog/feat-diff-schema-marks-data-loss-steps`.
