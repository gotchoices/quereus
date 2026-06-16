description: Surface a per-logical-transaction grouped delivery on the engine's `DatabaseEventEmitter` so a consumer can receive all data + schema events of one committed transaction (across all tables), in order, as a single group — dropped on rollback. This is the authoritative "HLC = transaction" boundary the sync layer needs. Pure engine change; no HLC/sync coupling. Reuses the existing transaction batching wholesale.
prereq:
files:
  - packages/quereus/src/core/database-events.ts           # DatabaseEventEmitter — add onTransactionCommit + fire from flushBatch
  - packages/quereus/src/core/database-transaction.ts       # beginTransaction/commitTransaction/rollbackTransaction already drive startBatch/flushBatch/discardBatch
  - packages/quereus/test/                                   # engine event tests
  - docs/sync.md                                            # § Transaction-Based Change Grouping / § Integration with Store Events — note the engine boundary is the grouping anchor
difficulty: medium
----

# Engine transaction-commit signal (the real "HLC = transaction" boundary)

## Why the engine, not the store

The store has **one `TransactionCoordinator` per table**
(`store-module.ts` `getCoordinator(tableKey)`), each registering its own
`StoreConnection`. A multi-table transaction therefore commits **several**
coordinators separately, each firing its own event burst — so a per-coordinator
(per-table) commit is the **wrong** anchor for "one HLC per transaction": it would
split a cross-table commit into multiple HLCs and break the referential-integrity
property `docs/sync.md` promises.

The single authoritative boundary already exists: the engine's
`DatabaseEventEmitter` (`database-events.ts`) hooks every module's emitter
(`hookModuleEmitter`) and **batches all data and schema events for the whole logical
transaction** — `batchedDataEvents` / `batchedSchemaEvents` plus savepoint layers —
bracketed by `startBatch()` at `beginTransaction`, `flushBatch()` at
`commitTransaction`, `discardBatch()` at `rollbackTransaction`
(`database-transaction.ts`). Savepoint rollback already discards the right layer.
`DatabaseDataChangeEvent` already carries `key/oldRow/newRow/changedColumns/remote`;
`DatabaseSchemaChangeEvent` carries `type/objectType/objectName/ddl/remote`. So the
flush point is the exact moment one transaction's complete, ordered, multi-table
fact set is known.

This ticket adds a **grouped delivery** at that flush point. It is independent of
sync and of HLC — a standalone engine capability.

## API

```ts
// database-events.ts
export interface TransactionCommitBatch {
  /** All data events of the committed transaction, in flush order (base + savepoint
   *  layers, same order flushBatch already emits them). */
  readonly dataEvents: ReadonlyArray<DatabaseDataChangeEvent>;
  /** All schema events of the committed transaction, in flush order. */
  readonly schemaEvents: ReadonlyArray<DatabaseSchemaChangeEvent>;
}

export type TransactionCommitListener = (batch: TransactionCommitBatch) => void;

class DatabaseEventEmitter {
  onTransactionCommit(listener: TransactionCommitListener): () => void;
}
```

## Semantics (RESOLVED)

- Fire `onTransactionCommit` **once** from inside `flushBatch()`, AFTER the existing
  per-event `emitDataEvent` / `emitSchemaEvent` delivery, with the full collected
  arrays (already materialized in `flushBatch` as `allDataEvents` / `allSchemaEvents`
  — reuse them; build the `DatabaseDataChangeEvent`/`DatabaseSchemaChangeEvent`
  projections exactly as the per-event path does so listeners see the same shapes).
- **Never** fire on `discardBatch()` (rollback) — a rolled-back transaction produces
  no group.
- An **empty** transaction (no data and no schema events) fires **nothing** — guard
  on `dataEvents.length + schemaEvents.length > 0` so idle commits don't spam
  listeners. (A transaction that produced only collision events still fires nothing
  on this channel — collisions keep their own channel.)
- Ordering within the batch: preserve the existing flush order (base batch then each
  savepoint layer, in push order). This is the order downstream `opSeq` assignment
  will follow; document that it is per-module/per-table arrival order at commit, not
  global DML-interleave order (store coordinators buffer per-table and fire at their
  own commit) — deterministic and replayable, which is what matters.
- Coexistence: the existing per-event `onDataChange`/`onSchemaChange` listeners are
  untouched and still fire. `onTransactionCommit` is purely additive — a second
  subscription for consumers that need the transaction grouping.

## Edge cases & interactions

- **Rollback / `ROLLBACK TO SAVEPOINT`** — discardBatch fires no group; a savepoint
  rollback that pops a layer must not include that layer's events in a later commit's
  group (already handled by `rollbackSavepointLayer` popping the layer before flush).
  Add a test: write, savepoint, write, rollback-to-savepoint, commit → group contains
  only the surviving writes.
- **Autocommit single statement** — each implicit transaction flushes its own group
  (one statement, possibly many row events). Test a multi-row INSERT → one group with
  N data events.
- **Multi-table transaction** — `begin; insert t1; insert t2; commit` → exactly **one**
  group containing both tables' events, in commit order. This is the core property;
  test it explicitly.
- **DDL + DML in one transaction** — `begin; create table…; insert…; commit` → one
  group carrying the schema event(s) and data event(s) together. Test presence of
  both in the same group (consumed by the sync ticket for shared-HLC ordering).
- **remote events** — events applied with `remote: true` (sync apply path) still flow
  through and appear in the group with `remote: true`; the consumer filters them.
  Test that a group preserves the `remote` flag.
- **No listeners** — when no `onTransactionCommit` listener is registered, building
  the batch object should be skipped (cheap guard) to avoid per-commit allocation in
  the common no-subscriber case.

## Key tests (TDD)

- Single-table multi-row autocommit → one group, N dataEvents, 0 schemaEvents.
- Multi-table explicit transaction → one group spanning both tables, commit order.
- DDL+DML transaction → one group with both schemaEvents and dataEvents.
- Rollback → no group. Rollback-to-savepoint then commit → group excludes rolled-back
  layer.
- Empty commit → no group.
- `remote: true` events preserved in the group.

## TODO

- Add `TransactionCommitBatch` / `TransactionCommitListener` types and the
  `transactionCommitListeners` set + `onTransactionCommit` subscribe/unsubscribe to
  `DatabaseEventEmitter` (mirror `onMaintenanceCollision`).
- In `flushBatch()`, after the existing emit loops, build the batch from the same
  `allDataEvents`/`allSchemaEvents` projections and dispatch to
  `transactionCommitListeners` (guarded by listener-count and non-empty). Wrap each
  listener call in try/catch + `errorLog` like the other channels.
- In `removeAllListeners` / teardown, clear the new listener set.
- Add the tests above to the engine event test suite.
- Update `docs/sync.md` (§ Transaction-Based Change Grouping and § Integration with
  Store Events) to state the engine's `DatabaseEventEmitter` transaction flush is the
  grouping boundary, and why the per-table store coordinator is not.
- `yarn workspace @quereus/quereus build`; `yarn workspace @quereus/quereus test`;
  `yarn lint` (single-quote globs on Windows) since engine + test files change.
