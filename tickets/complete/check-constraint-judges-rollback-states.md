description: Adding a CHECK constraint inside a transaction (by `add constraint` or inline on `add column`) now also checks every state a rollback could restore, and refuses as retryable when a row that would come back breaks the rule, so a restored violator can no longer disappear from queries that trust the constraint.
architecture: docs/module-authoring-transactions.md#ddl-inside-an-open-transaction
files:
  - packages/quereus/src/schema/constraint-builder.ts  # validateRowInvariantChecksOverExistingRows (effective pass, then each restorable state); scanChecksOverRows
  - packages/quereus/src/vtab/rollback-states.ts  # RestorableRowStates, distinctRestorableRows, describeAddCheck
  - packages/quereus/src/vtab/module.ts  # restorableRowStates hook contract
  - packages/quereus/src/vtab/table.ts  # savepointRowSources: depth-indexed, undefined = committed
  - packages/quereus/src/planner/building/table.ts  # buildTableSource / scanSuppliedRows
  - packages/quereus/src/planner/planning-context.ts  # RowSourceOverrides, rowSourceOverrideKey
  - packages/quereus/src/core/statement.ts  # _rowSourceOverrides
  - packages/quereus/src/core/database.ts  # ExistingRowScanPlanning
  - packages/quereus/src/planner/nodes/values-node.ts  # TableLiteralNode.rows accepts a re-callable source
  - packages/quereus/src/runtime/emit/values.ts
  - packages/quereus/src/planner/nodes/reference.ts  # tableSchemaAttributes
  - packages/quereus/src/runtime/emit/add-constraint.ts
  - packages/quereus/src/runtime/emit/alter-table.ts  # validateBackfillAgainstChecks
  - packages/quereus/src/runtime/emit/schema-declarative.ts
  - packages/quereus/src/vtab/memory/layer/connection.ts  # savepointRestoreLayersByDepth
  - packages/quereus/src/vtab/memory/layer/manager.ts  # restorableRowStates, savepointStatesByDepth
  - packages/quereus-store/src/common/store-module-index-build.ts  # bufferedRestorableRowStates
  - packages/quereus-store/src/common/store-module-index.ts
  - packages/quereus-isolation/src/isolation-module.ts  # overlayRowSources, restorableRowStates
  - packages/quereus-isolation/src/alter-migration.ts
  - packages/quereus/test/logic/41.2.4-ddl-rollback-states.sqllogic
  - packages/quereus-store/test/bare-ddl-rollback-states.spec.ts
  - packages/quereus-isolation/test/isolation-layer.spec.ts
  - docs/module-authoring-transactions.md
  - docs/memory-table.md
  - docs/store.md
----

# A new CHECK must hold in every state a rollback could restore

## What landed

On the bundled backends DDL survives `rollback` / `rollback to savepoint` while the rows it was judged against do not. The CHECK existing-row scan read only the rows the transaction could see, so a committed row the transaction had deleted (or one an open savepoint still held) could come back under the new CHECK, and the optimizer — which lifts a declared row-invariant CHECK into a fact about every stored row — then hid it from any query filtering for it.

`validateRowInvariantChecksOverExistingRows` (used by both `add constraint … check` arms, the `add column … check` literal-default path, and `apply schema`'s re-validation) now runs the effective scan first (violation → `CONSTRAINT`), then, if the table's module reports restorable states, the very same SQL once per distinct state with the table's rows replaced by that state's (violation → `BUSY`, "Commit the pending writes first, then retry.").

- **Module hook** `VirtualTableModule.restorableRowStates?(db, schemaName, tableName, ddl)` → `{ transaction, savepoints }` (`savepoints` indexed by database savepoint depth), or undefined when the issuing connection has no open work on the table. Implemented by memory (committed head + each open savepoint's layer, `savepointRestoreLayersByDepth`), the unwrapped store (`bufferedRestorableRowStates`, off the coordinator's op log), and the isolation layer (underlying's rows + overlay frames merged with them; delegates to the underlying when nothing is staged).
- **Row-source override**: `Statement._rowSourceOverrides` → `PlanningContext.rowSourceOverrides`, consulted by `buildTableSource`; an overridden table plans as a `TableLiteralNode` over the re-callable rows, so no module access plan and no CHECK/assertion lift applies over unjudged rows. `committed.<t>` reads are never overridden.
- `VirtualTable.savepointRowSources` is now indexed by depth, `undefined` (or a missing trailing entry) meaning "restores the committed rows".

Known gaps carried from implement (unchanged, see review findings): per-row-backfill `add column` refuses `CONSTRAINT` instead of `BUSY` (over-strict, never admits a violator); `apply schema` flattens the `BUSY` to `ERROR`; a CHECK subquery reading another table judges against that table's current rows (`NOTE:` on `validateRowInvariantChecksOverExistingRows`; such CHECKs are never lifted).

## Review findings

Read the `ticket(implement): check-constraint-judges-rollback-states` diff in full before the handoff, then the touched docs.

**Checked, correct as written**
- Memory savepoint-to-state mapping (`savepointRestoreLayersByDepth`): eager entry → its snapshot; lazy marker taken over an own eager snapshot (`readSnapshot !== null`) → that layer; lazy marker over a committed view → committed rows. Matches `rollbackToSavepoint`'s restore logic and `ensureSchemaChangeSafety`'s re-pointing. Reading the committed head (not base) before the drain on the `add constraint` path is right.
- Store depth indexing: `TransactionCoordinator.createSavepoint(depth)` asserts the stack length equals the database depth, so `getOrderedPendingOpsAtSavepoints` is depth-indexed as the hook contract claims. `bufferedRollbackScans` returns `[]` when nothing is buffered → hook returns undefined → no second scan.
- Isolation poison / no-changes handling mirrors `issuerRowSources`; overlay without `savepointRowSources` refuses `BUSY` under open savepoints (covered by the extended isolation test).
- Plan reuse: the engine has no SQL-text plan cache (only the internal FK statement cache, which this path doesn't use); each pass `prepare`s its own `Statement`, so the override can't leak into the effective pass or vice versa.
- `TableLiteralNode` consumers: only `emitTableLiteral` reads `.rows`; the new function branch is correct. The literal's relation type comes from `relationTypeFromTableSchema` (PK/NOT NULL keys), which every restorable state satisfies.
- Error paths: effective violation keeps `CONSTRAINT` (sqllogic L); released savepoint is not a state (K).
- Tests: the sqllogic I–M cases and the two store specs each pin a distinct behaviour (reproduction, savepoint-only, released, effective-first, add-column); the isolation assertion pins the refusal arm. None restate the implementation; none cut, none added.

**Fixed inline (minor)**
- `planner/nodes/reference.ts`: the extraction of `tableSchemaAttributes` left `TableReferenceNode`'s doc comment stacked above the new function; moved it back onto the class.
- `quereus-isolation/src/isolation-module.ts` `restorableRowStates`: `savepointRowSources` may stop short of the open depth (a missing trailing entry = committed rows), but `RestorableRowStates.savepoints` promises one entry per depth — the foreign-key ticket pairs by that index. Now padded to `getActiveSavepointDepth()` with `transaction`.
- `core/statement.ts`: `_rowSourceOverrides` doc named `validateChecksOverExistingRows` as its setter; the setter is `scanChecksOverRows`.
- `vtab/table.ts` `savepointRowSources` doc and `docs/memory-table.md` § DDL and transactions: re-wrapped lines the edit left over-long.

**Tripwires parked**
- `apply schema` flattening a rollback-state `BUSY` to `ERROR`: consistent with the existing deliberate `NOTE:` in `executeMigrationStep`; added a matching `NOTE:` on `recreatedObjectBrokeCheck` (`runtime/emit/schema-declarative.ts`).
- Cross-table CHECK subquery judged against the other table's current rows: already parked by implement as a `NOTE:` on `validateRowInvariantChecksOverExistingRows`; agree with it.

**Major / tickets filed**: none. The per-row-backfill `add column` status (`CONSTRAINT` vs `BUSY`) is over-strict but never admits a violator and is documented in the handoff; no class-level invariant or current-release anchor justifies a ticket.

**Docs**: `docs/module-authoring-transactions.md` (new § When the engine judges the rows), `docs/memory-table.md`, `docs/store.md` read in full against the code — accurate after the re-wrap.

**Validation**: `yarn build`, `yarn lint`, `yarn typecheck` clean; `@quereus/quereus` test 11093 passing / 26 pending; `yarn test:store` 11086 passing / 33 pending; `@quereus/isolation` 451 passing; `@quereus/store` 1988 passing.
