description: The store and memory modules keep per-row change records during a transaction even when nobody is listening for those changes; they could skip that work and use less memory on large imports.
prereq: public-needs-data-events-query
architecture: docs/module-events.md#module-integration
files:
  - packages/quereus-store/src/common/store-table-base.ts   # `emitOrQueueDataChange` (~line 802), the single route for table write events
  - packages/quereus-store/src/common/transaction.ts        # `queueEvent` pushes to `pendingEvents` with no gate (~line 236)
  - packages/quereus-store/src/common/backing-host.ts       # other `queueEvent` callers (~lines 238, 440)
  - packages/quereus-store/src/common/events.ts             # `StoreEventEmitter`, whose listener count includes the database's own subscription
  - packages/quereus/src/vtab/memory/layer/manager.ts       # `hasDataListeners` gates on change tracking (~lines 576, 803, 1041)
  - packages/quereus-plugin-indexeddb/src/broadcast.ts      # subscribes directly to the store emitter (~line 60)
tradeoffs: The saving matters only for large transactions with no listeners, and each module must also count subscribers on its own emitter, so an incorrect count would silently lose events for cross-tab sync or per-table subscribers.
----

Noticed while planning `public-needs-data-events-query`, which adds `Database.needsDataEvents()`. Lamina has this memory problem and is adopting that method. The modules in this repository have the same pattern. Neither has been measured; both findings come from reading the code.

## Current behaviour

**Store module.** Within a transaction, `TransactionCoordinator.queueEvent` adds every event to `pendingEvents` without checking whether anyone is listening. That is one array entry per row written, held until commit, including row images.

**Memory module, when constructed with an emitter.** `MemoryTableManager` turns on change tracking only if `this.eventEmitter?.hasDataListeners?.()` is true. That check looks like it skips the work, but `DatabaseEventEmitter.hookModuleEmitter` subscribes to the emitter when the module is registered through `Database.registerModule`, so it is true from then on. The default `memory` module has no emitter and uses the automatic event path, so this affects only hosts that register a memory module with an emitter.

## Expected behaviour

When nothing will receive a data event, these modules should not hold per-row event records. A module should build events when either of these is true:

- `db.needsDataEvents()` returns `true`.
- A subscriber is attached directly to the module's emitter, not counting the database's own subscription.

The second condition is required. `db.getTable(...).getEventEmitter()` is a documented way to subscribe (docs/usage.md § Per-Table Subscription), `docs/store.md` shows direct subscription to the store emitter, and the IndexedDB plugin's cross-tab broadcast relies on it. The second condition therefore needs a way to tell the database's subscription apart from direct ones, which neither emitter offers today.

## Use case

A multi-million-row import into a store-backed table, on a database with no data listeners, should not hold a per-row event list for the length of the transaction.

Before acting on this, measure how much of an import's transaction memory `pendingEvents` accounts for. The store's `pendingOps` also grows with each row, so removing the events may not change the total much.
