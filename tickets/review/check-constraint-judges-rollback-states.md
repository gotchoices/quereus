description: Adding a CHECK constraint inside a transaction (by `add constraint` or inline on `add column`) now also checks every state a rollback could restore, and refuses as retryable when a row that would come back breaks the rule, so a restored violator can no longer disappear from queries that trust the constraint.
architecture: docs/module-authoring-transactions.md#ddl-inside-an-open-transaction
files:
  - packages/quereus/src/schema/constraint-builder.ts  # validateRowInvariantChecksOverExistingRows (now: effective pass, then each restorable state); scanChecksOverRows
  - packages/quereus/src/vtab/rollback-states.ts  # RestorableRowStates, distinctRestorableRows, describeAddCheck
  - packages/quereus/src/vtab/module.ts  # restorableRowStates hook contract
  - packages/quereus/src/vtab/table.ts  # savepointRowSources: now depth-indexed, undefined = committed
  - packages/quereus/src/planner/building/table.ts  # buildTableSource / scanSuppliedRows
  - packages/quereus/src/planner/planning-context.ts  # RowSourceOverrides, rowSourceOverrideKey
  - packages/quereus/src/core/statement.ts  # _rowSourceOverrides
  - packages/quereus/src/core/database.ts  # ExistingRowScanPlanning, _buildPlan / _buildProbeContext 4th param
  - packages/quereus/src/planner/nodes/values-node.ts  # TableLiteralNode.rows accepts a re-callable source
  - packages/quereus/src/runtime/emit/values.ts
  - packages/quereus/src/planner/nodes/reference.ts  # tableSchemaAttributes (shared with the literal scan)
  - packages/quereus/src/runtime/emit/add-constraint.ts  # rejectCheckViolatedByExistingRows gains `ddl`
  - packages/quereus/src/runtime/emit/alter-table.ts  # validateBackfillAgainstChecks
  - packages/quereus/src/runtime/emit/schema-declarative.ts  # apply-schema re-validation caller
  - packages/quereus/src/vtab/memory/layer/connection.ts  # savepointRestoreLayersByDepth
  - packages/quereus/src/vtab/memory/layer/manager.ts  # restorableRowStates, savepointStatesByDepth, savepointRowSources
  - packages/quereus/src/vtab/memory/module.ts
  - packages/quereus/src/vtab/memory/table.ts
  - packages/quereus-store/src/common/store-module-index-build.ts  # bufferedRestorableRowStates; rollbackStates reuses it
  - packages/quereus-store/src/common/store-module-index.ts  # StoreModuleIndex.restorableRowStates
  - packages/quereus-isolation/src/isolation-module.ts  # overlayRowSources, restorableRowStates
  - packages/quereus-isolation/src/alter-migration.ts  # consumer of the depth-indexed savepointRowSources
  - packages/quereus/test/logic/41.2.4-ddl-rollback-states.sqllogic
  - packages/quereus-store/test/bare-ddl-rollback-states.spec.ts
  - packages/quereus-isolation/test/isolation-layer.spec.ts
  - docs/module-authoring-transactions.md
  - docs/memory-table.md
  - docs/store.md
----

# A new CHECK must hold in every state a rollback could restore — review handoff

## What changed

On the bundled backends DDL survives `rollback` / `rollback to savepoint` while the rows it was judged against do not. The CHECK existing-row scan (`select 1 from <t> as <alias> where not (<predicate>) limit 1`) only read the rows the transaction can see, so a committed row the transaction had deleted (or one an open savepoint still held) could come back under the new CHECK, and the optimizer — which lifts a declared row-invariant CHECK into a fact about every stored row — then hid it from any query filtering for it.

Now `validateRowInvariantChecksOverExistingRows` (the one ALTER-path entry point, used by both `add constraint … check` arms, the `add column … check` literal-default path and `apply schema`'s re-validation) runs:

1. the effective scan, as before — a violation there stays `CONSTRAINT`;
2. then, if the table's module reports restorable states, the very same SQL once per distinct state with the table's rows replaced by that state's — a violation there becomes `BUSY` ("Commit the pending writes first, then retry.") through `judgeRestorableStates`.

### The two pieces

- **Module hook** `VirtualTableModule.restorableRowStates?(db, schemaName, tableName, ddl)` → `RestorableRowStates | undefined` (`{ transaction, savepoints }`, `savepoints` indexed by database savepoint depth, entries for a savepoint taken before the table had work are `transaction` itself). Undefined when the issuing connection has no open work on the table (no second scan).
  - Memory: committed head (not base — the hook runs before `ensureSchemaChangeSafety` on the add-constraint path) plus each open savepoint's layer, via the new depth-preserving `MemoryTableConnection.savepointRestoreLayersByDepth` (lazy markers that captured a committed view map to the committed rows). The old deduping `savepointRestoreLayers` (connection and manager) is gone; `restorableStates` and `savepointRowSources` are rebuilt on the same walk.
  - Store, unwrapped: `bufferedRestorableRowStates` from `bufferedRollbackScans` (the unwrapped arm of `rollbackStates` now reuses it). Uses `getTable`, not a reconnect.
  - Isolation: delegates to the underlying when the issuer has nothing staged; otherwise `transaction` = the underlying's own rows (`committedRowsOf`) and `savepoints` = the overlay frames merged with them (`overlayRowSources`, the construction `effectiveRowsFor` already used, now kept per depth). An overlay module without `savepointRowSources` refuses `BUSY` under open savepoints.
- **Row-source override**: `Statement._rowSourceOverrides` → `ExistingRowScanPlanning` → `PlanningContext.rowSourceOverrides`, consulted by the new `buildTableSource` (used by both table branches of `select.ts`'s FROM builder; DML/ALTER callers keep `buildTableReference` and its `RetrieveNode`). An overridden table plans as a `TableLiteralNode` over the re-callable rows, typed and attributed exactly as its `TableReferenceNode` would be (`tableSchemaAttributes` is now shared). No module access plan, no CHECK/assertion lift over unjudged rows; a subquery in the CHECK reading the same table reads the same state. `committed.<t>` reads are never overridden. Leaf literals are not const-folded (the const pass requires children), so the rows are read at execution time.

### Deviations from the plan in the implement ticket — please weigh

- The hook takes a fourth `ddl: string` argument. The isolation wrapper must refuse with `rolledBackRowsWouldViolate(ddl, …)` when its overlay cannot report frames, and had no other way to name the statement.
- `VirtualTable.savepointRowSources` changed contract: it is now indexed by savepoint depth, with `undefined` (or a missing trailing entry) meaning "restores the committed rows". This was needed for the isolation hook's depth indexing (the foreign key ticket pairs child/parent states by depth). Both consumers (`effectiveRowsFor`, `assertNoMarkerAtNullKeyInSavepointFrames`) filter/dedupe.
- No separate helper: the restorable pass was folded into `validateRowInvariantChecksOverExistingRows`, which gained a required `ddl` parameter (exported from `index.ts`; no in-repo external caller). `_buildPlan` / `_buildProbeContext`'s 4th parameter changed from `noEnvelopeContextTable?: TableSchema` to an options bag `ExistingRowScanPlanning`.
- Add column: no per-state "apply the backfill value" mapping was needed. The pass reads the states AFTER `module.alterTable(addColumn)`, so each already carries the column as the module wrote it: memory backfills base + every layer; the unwrapped store flushes its buffered writes before rewriting rows (so it reports nothing — verified ad hoc: the statement lands and the delete is durable after `rollback`); isolation reshapes the underlying's rows and the overlay frames in place. The hook contract documents "rows are in the table's current column layout".

## Known gaps (not fixed)

- **Add column with a per-row backfill (non-literal DEFAULT such as `default (new.v - 5)`, or GENERATED)**: the CHECK runs inside the module's backfill hook over every row the module rewrites, so on memory a violator the transaction deleted refuses with `CONSTRAINT` instead of `BUSY` (verified ad hoc). Over-strict status, never admits a violator. Not in this ticket's scope (that path never reaches `validateBackfillAgainstChecks`).
- **`apply schema` re-validation**: gets the pass, but `recreatedObjectBrokeCheck` rewraps any failure as `ERROR`, so the `BUSY` retryable status is lost there (the message still says "commit the pending writes first").
- **CHECK with a subquery reading another table**: each state of this table is judged against the other table's current rows, not its rows after the same rollback. Parked as a `NOTE:` on `validateRowInvariantChecksOverExistingRows`; such CHECKs are never lifted, so nothing vanishes from queries.

## Tests added

- `41.2.4-ddl-rollback-states.sqllogic` (memory and `yarn test:store`):
  - I — committed violator deleted in the transaction → BUSY; after `rollback`, `select … where v <= 0` returns it; delete in autocommit, then the constraint lands and enforces. (The reproduction; fails without the pass — verified by short-circuiting it.)
  - J — violator only at an open savepoint → BUSY; `rollback to` shows it.
  - K — released savepoint is not a state → lands and enforces.
  - L — visible violator also present in committed rows → `CONSTRAINT`, not `BUSY` (effective pass runs first).
  - M — `add column w … default -1 check (w > 0)` over a deleted committed row → BUSY; the column is reverted and `rollback` restores the row without it.
- `quereus-store/test/bare-ddl-rollback-states.spec.ts` — unwrapped store: committed-row reproduction (BUSY, then the row is visible to `where v <= 0` after rollback) and savepoint-only violator (BUSY).
- `quereus-isolation/test/isolation-layer.spec.ts` — the existing "overlay module that cannot report its savepoint frames" test now also asserts `add check` refuses `BUSY` through the new hook.

Not tested (by design): `permitsGrandfatheredCheckViolators` skip (unchanged early return), "no open work → no second scan" (performance only).

## Validation run

`yarn build`, `yarn lint`, `yarn typecheck`, `yarn test` (all workspaces; quereus 11093 passing) and `yarn test:store` (11086 passing) — all green.
