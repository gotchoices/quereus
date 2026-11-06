description: Adding a FOREIGN KEY inside a transaction now also checks every state a rollback could restore, pairing the child table's rows and the parent table's rows at the same rollback point, and refuses as retryable when one would leave a child row with no parent.
prereq: check-constraint-judges-rollback-states
architecture: docs/module-authoring-transactions.md#ddl-inside-an-open-transaction
files:
  - packages/quereus/src/schema/constraint-builder.ts  # validateAddedForeignKeyOverExistingRows (new ALTER entry), validateForeignKeyOverExistingRows (effective only, MV caller), foreignKeyOrphanScan, scanForOrphans, foreignKeyRollbackPoints, rowsAtSavepoint, restorableStatesOf
  - packages/quereus/src/vtab/rollback-states.ts  # describeAddForeignKey; refusal message reworded
  - packages/quereus/src/index.ts  # exports
  - packages/quereus/src/vtab/memory/layer/manager.ts  # addForeignKeyConstraint calls the new entry
  - packages/quereus-store/src/common/store-module-alter.ts  # alterAddConstraint foreignKey arm calls the new entry
  - packages/quereus/src/vtab/module.ts  # restorableRowStates doc
  - packages/quereus/src/core/statement.ts  # _rowSourceOverrides doc
  - packages/quereus-isolation/src/isolation-module.ts  # restorableRowStates doc
  - packages/quereus/test/logic/41.2.4-ddl-rollback-states.sqllogic  # cases N–S
  - docs/module-authoring-transactions.md
  - docs/memory-table.md
  - docs/store.md
----

# A new FOREIGN KEY must hold in every state a rollback could restore

## What changed

The FK existing-row scan read only the rows the transaction could see. DDL survives `rollback` / `rollback to savepoint` on the bundled backends while the rows do not, so a committed orphan the transaction had deleted came back under the surviving constraint (verified repro in the original ticket, memory and `test:store`).

- `validateAddedForeignKeyOverExistingRows(db, childSchema, fk, ddl)` (new, `constraint-builder.ts`) is what both module FK arms now call: memory `addForeignKeyConstraint` and store `alterAddConstraint`. Both still skip it entirely when `restoring` is set (checked: `if (!restoring)` / `if (!change.restoring)` wrap the call). It runs the effective scan first (visible orphan → `CONSTRAINT`), then `judgeRestorableStates` over the rollback points (orphan only there → `BUSY`). The `foreign_keys` pragma gate is at the top.
- **Pairing** (`foreignKeyRollbackPoints`): points = whole-transaction rollback + each savepoint depth up to the longer of the two tables' `savepoints`. At each point the child's state and the parent's state at that same point both go into one `_rowSourceOverrides` map, so the same SQL is reused. A table whose hook returns undefined (or has no hook) gets no override. Self-referencing FK: parent states are not fetched; the one child override serves both reads (same override key). Absent parent: no parent override. Pairs of identical streams are deduplicated. Neither table with open work → no extra scan. A missing `savepoints[d]` entry is read as "restores committed rows" (`rowsAtSavepoint`), the same as `savepointRowSources` reads a missing trailing entry.
- Hooks are resolved from the **catalog's** table entry (`restorableStatesOf` → `db.schemaManager.findTable` → `requireVtabModule`), because the FK arm runs inside the module's `alterTable` holding the module's own copy of the child schema. Under `test:store` this resolves to the isolation wrapper.
- `validateForeignKeyOverExistingRows` keeps its signature and is now effective-only. Only the materialized-view derivation caller (`materialized-view-helpers.ts`) uses it. That caller validates a derived image it just built, and its CHECK scan (`validateChecksOverExistingRows`) judges no rollback state either.
- **Refusal message reworded** (shared, `rolledBackRowsWouldViolate`): was "rows this transaction has deleted or overwritten would violate it if the transaction rolled back", now "rolling back this transaction would leave rows that break it. Commit the pending writes first, then retry." The old wording was false for the parent-side case, where the transaction *inserted* a parent row. Tests match only `/commit the pending writes first/i`; I updated the quotes in docs/memory-table.md and docs/module-authoring-transactions.md.

## Deviation from the ticket — please weigh

The ticket asked for `ddl` = `add column <name>` on the `add column … references` path. The module FK arm cannot tell that path apart: `runAddColumn` re-drives the inline constraint as a plain `addConstraint` change, and `SchemaChangeInfo` carries nothing that identifies the statement. So the refusal says `add foreign key` / `add constraint <name> foreign key` on both paths. The UNIQUE arms already behave this way (`add unique (…)` on the add-column path). Fixing it would mean adding a field to the `addConstraint` variant of `SchemaChangeInfo` (e.g. `statement?: string`, set by `runAddColumn`) and having the memory, store and isolation UNIQUE and FK arms honour it. I judged that a module-interface change for message text alone and left it out; the docs note the behaviour. Verified by hand: `begin; insert into p values (5); alter table c add column pid integer default 5 references p(id)` with a committed `c` row → `BUSY` "Cannot add foreign key on table c: …", the column is reverted, and after `commit` the same statement lands.

## Tests added (all in `41.2.4-ddl-rollback-states.sqllogic`, under `pragma foreign_keys = true`, reset to false at the end)

- **N**: committed orphan deleted in the transaction → `BUSY`. After rollback the orphan is visible to a `not exists` query (no constraint folds it away). Delete + autocommit add then lands, and a later orphan insert fails. This is the reproduction: confirmed it fails with the rollback-state pass disabled.
- **O**: parent inserted in the transaction rescues a committed orphan, and the child has no open work → `BUSY`. Then `commit` + the same statement lands. This catches an implementation that only walks the child's states.
- **P**: parent deleted together with its child rows → lands. Rollback restores both, and the FK is enforced afterwards. This catches judging child states against the *current* parent (a false refusal).
- **Q**: orphan only at an open savepoint (child row staged before `savepoint s`, parent row after) → `BUSY`. `rollback to savepoint s` shows the orphan.
- **R**: self-referencing FK, a row deleted together with the row that references it → lands. This catches a self-ref parent read taking the current rows instead of the same state.
- **S**: visible orphan while the transaction has open work → `CONSTRAINT` (effective scan first).

The child-side insert violation surfaces as `CHECK constraint failed: <fk name>` (the existing FK enforcement message), so the tests match that.

## Validation

`yarn build`, `yarn lint`, `yarn typecheck` clean. `yarn test`: all workspaces green (`@quereus/quereus` 11093 passing / 26 pending — the count is unchanged because the cases went into an existing file). `yarn test:store`: 11086 passing / 33 pending. After the full runs I edited comments only, then re-ran lint and the isolation build.

## Known gaps / things for the reviewer to probe

- No isolation-package spec or bare-store spec was added for FK. The CHECK prereq added `bare-ddl-rollback-states.spec.ts` (store without the wrapper) and an isolation refusal assertion. The FK pass uses the same hooks, but the **bare store** FK path (store module's own `bufferedRestorableRowStates` read from inside its own `alterAddConstraint`) is exercised by no test. `test:store` runs isolation-over-store, where the store reports nothing. Consider whether one bare-store case pays for itself.
- The parent table's memory manager is not drained and holds no latch when its hook is called. `restorableRowStates` reads the committed head for that reason (comment updated). Worth a second look that no parent-side path assumes head == base.
- Materialized-view attach inside a transaction, followed by a rollback, leaves the old contents under the attached FK unjudged. This is the same as its CHECK scan and not addressed here. Raise it only if you think the MV path's rows roll back the way a plain table's do.
- `apply schema` re-adding an FK: its unwind passes `restoring` (skipped). A fresh FK added by `apply schema` in an open transaction would now refuse `BUSY` like the ALTER path. I did not check whether `apply schema` flattens that to `ERROR`, as the CHECK review noted for its path.
