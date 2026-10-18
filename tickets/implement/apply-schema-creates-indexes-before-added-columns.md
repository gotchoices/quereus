description: A schema change that adds a column and an index on that column in the same "apply schema" used to fail, because the migration plan created the index before adding the column. The fix is already in the working tree; this ticket is for confirming it and finishing verification.
architecture: docs/schema.md#migration-order
files: packages/quereus/src/schema/schema-differ.ts (`generateMigrationPlan` end of function, `computeSchemaDiff` index loop ~850-895), packages/quereus/test/apply-schema-index-order.spec.ts (new), packages/quereus/test/schema-differ.spec.ts, packages/quereus/test/schema/differ-undo-plan.spec.ts, packages/quereus/test/index-ddl-roundtrip.spec.ts, packages/quereus/test/logic/50.2.1-declare-schema-index-renames.sqllogic, docs/schema.md, docs/schema-rename-detection.md
difficulty: easy
repro: verified
----

# apply schema creates indexes before the columns it adds — fix landed in the tree, needs verification

Reproduction (memory module): declare `t(id)`, apply, insert a row, then declare `t(id, b text null)` plus `index t_b on t (b)` and apply → "Column 'b' not found in table 't'". Cause: `generateMigrationPlan` pushed index creates before the per-table alter block (`RENAME COLUMN` → `ADD COLUMN` → …).

## What was done (during the fix stage)

- `generateMigrationPlan` now pushes `diff.indexesToCreate` after the alter block and the maintained re-attaches, right before the assertion creates (comments at both sites name the reason). `DROP INDEX` stays early.
- Consequence found while running the suite: a hinted index rename used to render its recreate with in-diff column renames inverse-applied (NEW→OLD), because the create ran before `RENAME COLUMN`. With the create now after the rename, that would reference a column that no longer exists, so `columnReconciledIndexStmt` was deleted and the recreate uses the declared statement verbatim. (View creates still precede the alter block and keep their reconciliation.)
- Tests: new `apply-schema-index-order.spec.ts` (add column + index; hinted column rename + index on the new name; drop index with its column; forced failure after the moved index create — a later unique index over duplicate data — restores the pre-apply catalog). Updated expected plan order in `schema-differ.spec.ts`, `differ-undo-plan.spec.ts`, `index-ddl-roundtrip.spec.ts` (index recreate now names the NEW column) and `50.2.1-declare-schema-index-renames.sqllogic`.
- Docs: `docs/schema.md` Migration Order gains step 5 (index and assertion creates last); `docs/schema-rename-detection.md` no longer mentions `columnReconciledIndexStmt`.

## Status

`yarn lint` clean; `yarn test` in `packages/quereus` passed except one timeout in `alter-table-conformance.spec.ts` (`dropConstraint → UNSUPPORTED`, 10s) under a very slow run; that spec passes in isolation (not related to this change).

## TODO

- Run `yarn test:store` (LevelDB store path) to confirm index ordering holds there too.
- Re-run full `yarn test` once on an unloaded machine to confirm the conformance timeout does not recur.
- Skim the diff of `schema-differ.ts` for now-unused imports/helpers after the `columnReconciledIndexStmt` removal (lint passed, so likely none).
