description: Review the engine's new per-transaction grouped commit delivery (`DatabaseEventEmitter.onTransactionCommit`) — the authoritative "one logical transaction = one group" boundary the sync layer anchors an HLC to. Additive channel fired once from `flushBatch()`, carrying all data + schema events of one committed transaction across all tables, in flush order; dropped on rollback; silent on empty commits.
prereq:
files:
  - packages/quereus/src/core/database-events.ts            # TransactionCommitBatch/Listener types, transactionCommitListeners set, onTransactionCommit, needsData/SchemaEvents, projection helpers, flushBatch dispatch
  - packages/quereus/src/core/database.ts                   # Database.onTransactionCommit, _needsDataEvents/_needsSchemaEvents, type import
  - packages/quereus/src/index.ts                           # re-export TransactionCommitBatch / TransactionCommitListener
  - packages/quereus/src/runtime/emit/dml-executor.ts       # auto-event gate widened: hasDataListeners() -> _needsDataEvents() (3 sites)
  - packages/quereus/src/schema/manager.ts                  # auto-schema-event gate widened: hasSchemaListeners() -> _needsSchemaEvents() (2 sites)
  - packages/quereus/test/database-events.spec.ts           # 9 new tests under "Transaction-Commit Grouping"
  - docs/sync.md                                            # § Transaction-Based Change Grouping + § Integration with Store Events
difficulty: medium
----

# Review: engine transaction-commit signal

## What landed

A standalone, additive engine capability: `db.onTransactionCommit(listener)`. Each
committed logical transaction delivers exactly **one** `TransactionCommitBatch`:

```ts
interface TransactionCommitBatch {
  readonly dataEvents:   ReadonlyArray<DatabaseDataChangeEvent>;   // flush order
  readonly schemaEvents: ReadonlyArray<DatabaseSchemaChangeEvent>; // flush order
}
type TransactionCommitListener = (batch: TransactionCommitBatch) => void;
```

Mechanics (all in `database-events.ts`):
- New `transactionCommitListeners` set + `onTransactionCommit` / `hasTransactionCommitListeners`, mirroring the `onMaintenanceCollision` channel.
- Per-event projection extracted into `toDataChangeEvent` / `toSchemaChangeEvent`, reused by both the per-event emit path and the grouped batch so listeners see identical shapes.
- Dispatch added at the **end** of `flushBatch()`, after the per-event schema→data→collision loops. Built from the same `allDataEvents` / `allSchemaEvents` arrays. Guarded twice: skipped when no transaction-commit listener is subscribed (no per-commit allocation) **and** when `dataEvents.length + schemaEvents.length === 0` (empty/idle commit, or a collisions-only transaction — collisions keep their own channel). Listener calls wrapped in try/catch + `errorLog`, like the other channels.
- `removeAllListeners()` clears the new set and counts it in the leak warning.

`Database.onTransactionCommit` delegates to the emitter (with `checkOpen()`); types re-exported from `index.ts`.

`database-transaction.ts` was **not** modified despite being listed in the source ticket — `commitTransaction` already calls `flushBatch()` on success / `discardBatch()` on rollback, and the flush point is the exact hook. No transaction-manager change was needed.

## ⚠️ Scope expansion the reviewer should scrutinize first — the gating fix

The source ticket assumed the data/schema events are "already collected" and the change is purely at the flush point. **They are not unconditionally collected.** For modules **without native event support** — which includes the default in-memory module that `new Database()` registers (`new MemoryTableModule()` with no emitter) — auto-event *generation* is gated upstream:
- `dml-executor.ts`: `needsAutoEvents = ctx.db.hasDataListeners() && !hasNativeEventSupport(vtab)`
- `schema/manager.ts`: `if (this.db.hasSchemaListeners() && !hasNativeEventSupport(...))`

So a consumer subscribing **only** to `onTransactionCommit` (the intended standalone usage, and what the sync ticket will do) would have produced **empty batches that never fire** on the default engine. To make the channel actually standalone I:
- Added emitter `needsDataEvents()` / `needsSchemaEvents()` = `hasData/SchemaListeners() || hasTransactionCommitListeners()`.
- Added `Database._needsDataEvents()` / `_needsSchemaEvents()` (internal) delegating to them.
- Widened the 3 DML gates and 2 schema-manager gates from `has*Listeners()` to `_needs*Events()`.

Public `hasDataListeners()` / `hasSchemaListeners()` semantics are **unchanged** (a test asserts their literal meaning), so existing per-event behavior is untouched: when no transaction-commit listener exists, `_needs*Events() === has*Listeners()`. Confirm this reasoning and that the widening is complete (no other auto-event generation gate keys off `has*Listeners()`).

## Key behaviors to validate (use cases)

- **Single-table multi-row autocommit** (`insert … values (..),(..),(..)`) → 1 batch, N dataEvents, 0 schemaEvents.
- **Multi-table explicit tx** (`begin; insert t1; insert t2; commit`) → exactly 1 batch spanning both tables, in commit order (t1 events then t2). The core property.
- **DDL+DML in one tx** (`begin; create table…; insert…; commit`) → 1 batch carrying schemaEvents **and** dataEvents together.
- **Rollback** → no batch. **`rollback to savepoint` then commit** → batch excludes the rolled-back layer's events.
- **Empty/idle commit** (`begin; commit`) → no batch.
- **`remote` flag preserved** in the grouped projection.
- **Coexistence** — per-event `onDataChange` still fires alongside the grouped batch.
- **Throwing listener isolated** from other transaction-commit listeners and from the commit.

All 9 are in `test/database-events.spec.ts` → `describe('Transaction-Commit Grouping')`. The DDL+DML and most tests subscribe **only** to `onTransactionCommit`, exercising the gating fix.

## Validation performed

- `yarn workspace @quereus/quereus build` → clean (exit 0).
- `yarn workspace @quereus/quereus test` → **6327 passing, 9 pending, 0 failing**.
- `yarn workspace @quereus/quereus lint` (eslint + `tsc -p tsconfig.test.json`) → clean (exit 0).

## Honest gaps — treat tests as a floor

- **Remote flag is tested at the emitter unit level, not end-to-end.** The in-memory engine never sets `remote: true` (that flag is owned by the store/sync apply path). The test drives `DatabaseEventEmitter` directly (`startBatch` → `emitAutoDataEvent({remote:true})` → `flushBatch`) to assert the projection carries the flag. **Not** exercised: a real store-backed remote apply producing a grouped batch with `remote: true`.
- **Native-module path untested here.** For native modules (store) the hooked module emitter forwards events unconditionally (the DB's forwarding listener keeps the module emitter's listener count > 0), so the batch is populated regardless of the gating fix — the fix only matters for the auto-event path. This is reasoned, **not** verified. Worth a `yarn test:store` run and/or a store-backed grouping test to confirm cross-coordinator events all land in one engine batch and ordering holds across coordinators.
- **Ordering claim** ("per-module/per-table arrival order at commit, not global DML-interleave") is tested only for the single-module memory case. Cross-module interleave ordering is documented but not asserted.
- **Collisions-only transaction fires nothing** on this channel — covered by the empty-guard reasoning and the empty-commit test, but not asserted with an actual coarsening-collision-only transaction.
- `removeAllListeners` leak-warning message string changed (added the transaction-commit count). No test asserts the message; low risk.

## Downstream

`tickets/plan/sync-hlc-transaction-grouping.md` (recent `2003b755`) is the intended consumer — it should subscribe to `onTransactionCommit` and assign one HLC per batch. Nothing in this ticket couples to HLC/sync; verify the API shape matches what that plan expects (in particular: it gets the grouped batch from a single subscription with no need to also subscribe to `onDataChange`).
