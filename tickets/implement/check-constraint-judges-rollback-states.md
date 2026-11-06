description: Adding a CHECK constraint inside a transaction (by `add constraint` or inline on `add column`) only checks the rows the transaction can see, so a row it deleted can come back on rollback, break the rule, and then disappear from queries because the optimizer trusts the constraint. The statement should also check every state a rollback could restore and refuse as retryable when one would break the rule.
architecture: docs/module-authoring-transactions.md#ddl-inside-an-open-transaction
files:
  - packages/quereus/src/runtime/emit/add-constraint.ts  # rejectCheckViolatedByExistingRows — the one place the new pass goes for add constraint
  - packages/quereus/src/runtime/emit/alter-table.ts  # validateBackfillAgainstChecks (add column inline CHECK) — calls the scan directly, needs the same pass
  - packages/quereus/src/schema/constraint-builder.ts  # validateChecksOverExistingRows: the SQL scan to re-run per state
  - packages/quereus/src/planner/building/table.ts  # buildTableReference: the one site that turns a FROM table into a plan node
  - packages/quereus/src/planner/nodes/values-node.ts  # TableLiteralNode: a relational node over JS-supplied rows
  - packages/quereus/src/core/statement.ts  # _schemaPathOverride / _noEnvelopeContextTable: precedent for statement-scoped planning overrides
  - packages/quereus/src/vtab/module.ts  # new optional module hook; IssuerRowSources for the shape of existing state lists
  - packages/quereus/src/vtab/rollback-states.ts  # judgeRestorableStates, rolledBackRowsWouldViolate
  - packages/quereus/src/vtab/memory/module.ts
  - packages/quereus/src/vtab/memory/layer/manager.ts  # restorableStates, savepointRestoreLayers, savepointRowSources
  - packages/quereus/src/vtab/memory/layer/connection.ts  # savepointStack, savepointRestoreLayers
  - packages/quereus-store/src/common/store-module-index-build.ts  # rollbackStates
  - packages/quereus-store/src/common/store-table-base.ts  # bufferedRollbackScans
  - packages/quereus-store/src/common/transaction.ts  # getOrderedPendingOpsAtSavepoints
  - packages/quereus-isolation/src/isolation-module.ts  # effectiveRowsFor: merged overlay savepoint frames
  - packages/quereus/test/logic/41.2.4-ddl-rollback-states.sqllogic  # existing cross-backend corpus for this rule
  - docs/module-authoring-transactions.md
  - docs/memory-table.md
  - docs/store.md
difficulty: hard
repro: verified
----

# A new CHECK must hold in every state a rollback could restore

## The bug

On the bundled backends DDL survives `rollback` / `rollback to savepoint` while the rows it was judged against do not (the `non-transactional` tier, docs/module-capabilities.md). Every other row-validating DDL (`create unique index`, `add constraint … unique`, `alter column … set collate / set data type / set not null`) therefore also judges each state a rollback could restore and refuses with `BUSY` ("Commit the pending writes first, then retry.") when one would break the new rule. The CHECK paths do not. Because the optimizer lifts a declared row-invariant CHECK into a fact about every stored row (`ruleFilterContradiction`), a restored violator vanishes from any query that filters for it.

Verified on the memory backend and under `yarn test:store` (store behind the isolation wrapper); the original report also saw it on the store without the wrapper:

```sql
create table t (id integer primary key, v integer);
insert into t values (1, -1), (2, 5);
begin;
delete from t where id = 1;
alter table t add constraint pos check (v > 0);  -- accepted; should be BUSY
rollback;
select * from t where v <= 0;  -- empty; row 1 (v = -1) is in the table
```

Same class, also verified on both backends — inline CHECK on `add column`, the backfilled default lands on the restored row:

```sql
create table t (id integer primary key, v integer);
insert into t values (1, 1);
begin;
delete from t where id = 1;
alter table t add column w integer default -1 check (w > 0);  -- accepted; should be BUSY
rollback;
select w from t;               -- [{"w":-1}]
select * from t where w <= 0;  -- empty
```

## Why the existing machinery does not reach it

The CHECK existing-row scan is the engine's, not the module's: `rejectCheckViolatedByExistingRows` (add constraint, both arms) and `validateBackfillAgainstChecks` (add column) run `validateChecksOverExistingRows`, which prepares `select 1 from <t> as <alias> where not (<stored-row predicate>) limit 1` and runs it through the ordinary read path. That path sees the effective rows only. The restorable states live inside each module (`MemoryTableManager.restorableStates`, the store's `rollbackStates`, the isolation wrapper's `effectiveRowsFor`) and nothing hands them to the engine. Moving CHECK evaluation into each module was rejected: it is the duplication `rejectCheckViolatedByExistingRows` was created to remove, and the only per-row evaluator a module has (`compilePredicate`) covers partial-index predicates, not arbitrary CHECK expressions.

## Design

Two pieces, both reused by the foreign key ticket (`foreign-key-constraint-judges-rollback-states`).

### 1. A module hook that reports the restorable states

A new optional method on `VirtualTableModule` (module-level, like `alterTable`, so the isolation wrapper can delegate and so the engine needs no `VirtualTable` instance):

```ts
/**
 * The rows `tableName` would show the connection `db` is running after each rollback the open
 * transaction could still perform, or undefined when that connection has no open work on the
 * table (every state equals the rows it can see now, so there is nothing extra to judge).
 * Read-only: must not drain, flush or otherwise mutate. Optional; a module without it is not
 * judged (status quo), which is correct for a module whose DDL rolls back with its data.
 */
restorableRowStates?(db: Database, schemaName: string, tableName: string): Promise<RestorableRowStates | undefined>;

interface RestorableRowStates {
	/** What a whole-transaction `rollback` restores: the committed rows. */
	readonly transaction: RestorableRows;
	/**
	 * What `rollback to` each open savepoint restores, indexed by the database's savepoint depth
	 * (the index passed to `VirtualTable.savepoint`), so states of two tables can be paired by
	 * rollback point. A savepoint taken before this table had any work restores the committed
	 * rows; entries may share one stream.
	 */
	readonly savepoints: readonly RestorableRows[];
}
```

The CHECK half only needs the flat list of states; the depth indexing is for the foreign key half, which must pair a child's state with its parent's at the same point. Define the type in `vtab/rollback-states.ts` and export it from `index.ts` beside `RestorableRows`.

Implementations, each built from the enumeration the module already has (stay DRY — refactor the private helpers to share with the hook rather than writing a second walk):

- **Memory** (`MemoryTableModule` → `MemoryTableManager`): committed rows are the current committed head (`_currentCommittedLayer`), not `baseLayer` — the hook runs before `ensureSchemaChangeSafety` drains, and must not drain. Savepoint states from the DDL connection's `savepointStack` per depth (`savepointRestoreLayers` dedupes by identity and drops depth; add a depth-preserving variant). Check how a connection that joined after savepoints were taken aligns its stack with the database depth (`connection.ts` around the `targetDepth > savepointStack.length` branches) and map the missing low depths to the committed rows. Keep each stream a sync walk wrapped as `RestorableRows`, for the reason on `effectiveDdlRows`.
- **Store, unwrapped**: `bufferedRollbackScans` already returns committed + one prefix per coordinator savepoint (`getOrderedPendingOpsAtSavepoints` maps the coordinator's stack 1:1). Decode with `rowsFromEntries`. Undefined when nothing is buffered for the table.
- **Isolation wrapper**: undefined when the issuing connection has no overlay for the table; otherwise `transaction` is the underlying table's own rows (the wrapper stages everything pending, so they are the committed rows) and `savepoints` are the overlay frames merged with them — the same `mergedWith` construction `effectiveRowsFor` uses. When the overlay module has no `savepointRowSources` and savepoints are open, throw `rolledBackRowsWouldViolate` exactly as `effectiveRowsFor` does (a state the wrapper cannot see must refuse, not pass).

### 2. Running the same scan over a supplied state

Re-run the very SQL `validateChecksOverExistingRows` builds, with the table's rows replaced by the state's rows, so types, collations, NULL handling, `new.` requalification and mutation-context rules are identical by construction. Mechanism: a statement-scoped planning override, in the style of `Statement._schemaPathOverride`:

```ts
/** Plan these tables' FROM references as a scan of the given rows instead of the module. */
_rowSourceOverrides?: ReadonlyMap<TableSchema, RestorableRows>;  // keyed however resolution identifies a table
```

threaded through `_buildPlan` into the planning context, and consulted in `buildTableReference`: when the resolved table has an override, plan a `TableLiteralNode` typed as the table's relation type (columns, types, collations — what `TableReferenceNode` reports) over the override's rows instead of `TableReferenceNode`/`RetrieveNode`. Consequences that make this the right shape:

- No module access plan, so no filter is claimed as handled by a module that is not serving the rows.
- No CHECK lift: lifting happens in `TableReferenceNode.computePhysical`, so the fold hazard documented on `rejectCheckViolatedByExistingRows` cannot hit the restorable pass even after the CHECK is declared.
- A subquery in the CHECK that reads the same table reads the same state, which is the right point-in-time answer.
- `TableLiteralNode`'s async-iterable arm is single-shot (`emitTableLiteral`); either prepare one statement per state (simplest — the pass only runs when there is open work) or let the node hold the re-callable `RestorableRows` and call it per run.

`buildTableReference` returns `RetrieveNode` today; check its callers before changing the return type.

### Where the new pass goes

- `rejectCheckViolatedByExistingRows`: after the effective scan, if `module.restorableRowStates` returns states, run the same scan over `transaction` and each of `savepoints` (dedupe identical streams), through `judgeRestorableStates` so a `CONSTRAINT` becomes the `BUSY` refusal. Its existing early returns cover the two exemptions in the original ticket: `_isSchemaUnwinding()` (undo of a dropped constraint during a failed `apply schema` — docs/schema-undo-plan.md § Guards during an unwind) and `permitsGrandfatheredCheckViolators`. The `apply schema` re-validation caller (`runStepsWithUndoJournal`) gets the pass too; that is consistent, since its rows roll back the same way.
- `validateBackfillAgainstChecks` (`alter-table.ts`): the same pass, with each state's rows extended by the column's backfill value as the module will write it into that state. Confirm per backend which states the add-column backfill actually reaches (memory: base + every layer; store and isolation frames: check) — a state the backfill does not reach gets the new column as NULL, which a CHECK passes. Factor so both callers share one "scan effective, then each restorable state" helper in `constraint-builder.ts`.
- The engine-side fallback arm (`runAddCheckEngineSide`, module without `alterTable`) goes through `rejectCheckViolatedByExistingRows` and needs nothing extra.
- `ddl` text for the refusal: `add constraint <name> check` (or `add check` when unnamed) and `add column <name>`; tests match `/commit the pending writes first/i`.

## Expected behavior

- A violation among the rows the transaction can see keeps `CONSTRAINT`.
- A violation confined to the committed rows or to an open savepoint's rows refuses with `BUSY`; the table, the catalog and the transaction are untouched, and `commit` followed by the same statement lands it (or fails with `CONSTRAINT` if the row is still there).
- A released savepoint is not a restorable state; a deleted row that satisfies the CHECK does not block.
- A module declaring `permitsGrandfatheredCheckViolators` is not judged.
- A transaction with no writes to the table pays no second scan (hook returns undefined).

## TODO

- Add `RestorableRowStates` and the optional `restorableRowStates` module hook; document the contract in `vtab/module.ts`.
- Implement the hook on the memory module (depth-preserving savepoint walk, committed head, late-joining connection alignment), refactoring `restorableStates` / `savepointRestoreLayers` to share it.
- Implement it on the store module (unwrapped) from `bufferedRollbackScans`.
- Implement it on the isolation module from the `effectiveRowsFor` construction, including the missing-`savepointRowSources` refusal; delegate to the underlying when there is no overlay work (expected: undefined).
- Add the statement-scoped row-source override, thread it through `_buildPlan`, and plan an overridden table as a `TableLiteralNode` in `buildTableReference`.
- Add a shared helper in `constraint-builder.ts` that runs the CHECK scan over the effective rows and then over each restorable state through `judgeRestorableStates`; call it from `rejectCheckViolatedByExistingRows` and `validateBackfillAgainstChecks` (with the backfill value applied per state as each backend writes it).
- Extend `test/logic/41.2.4-ddl-rollback-states.sqllogic` (runs on memory and under `yarn test:store`): add constraint check — committed-row violator deleted in the transaction (BUSY, then rollback and `select … where v <= 0` returns the row, then delete+commit and the constraint lands); violator only at an open savepoint (BUSY); released savepoint (lands); visible violator (CONSTRAINT); and the add-column inline CHECK case above. One case per behaviour.
- Cover the store without the isolation wrapper: check whether a spec already runs SQL against an unwrapped store (`packages/quereus-store/test`) and add the first reproduction there if so.
- Update docs: docs/module-authoring-transactions.md (the hook, and that CHECK is judged engine-side over its states), docs/memory-table.md § DDL and transactions rule 1 and docs/store.md (add `add constraint … check` and `add column … check` to the lists of statements that judge restorable states), docs/module-capabilities.md if it lists them.
- `yarn build`, `yarn test`, `yarn test:store`, `yarn lint`.
