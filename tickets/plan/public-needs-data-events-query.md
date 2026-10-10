description: Give modules a public way to ask a Quereus database whether anyone is listening for data-change events (per-row listeners or transaction-commit listeners), so a module with its own event emitter can skip preparing events nobody will receive.
architecture: docs/module-events.md#module-integration
files:
  - packages/quereus/src/core/database.ts          # `hasDataListeners()` (public, ~line 1310) and `_needsDataEvents()` (@internal, ~line 1328)
  - packages/quereus/src/core/database-events.ts   # `DatabaseEventEmitter.needsDataEvents()` — dataListeners OR transactionCommitListeners, false inside `withPublicEventsSuppressed`
  - packages/quereus/src/runtime/emit/dml-executor.ts  # the auto-event gate that calls `_needsDataEvents()` today
  - docs/module-events.md                         # § Module Integration → For Modules with Native Events
----

Filed from the lamina board (lamina ticket `debt-row-change-event-buffer-grows-per-row-until-commit`, now split into `row-change-subscription-interest` and `quereus-row-change-interest`).

## Problem

A module that implements `getEventEmitter()` produces its own `VTableDataChangeEvent`s. Lamina does this: every committed row write becomes one event, and to emit it after commit lamina holds a per-row record in memory until the transaction commits. On a multi-million-row import that record is the last piece of a transaction whose memory grows with the row count, and in the common case nobody is listening.

The module's own emitter cannot tell it whether anyone listens. `Database.hookModuleEvents` subscribes the database to the module emitter as soon as the module is registered, so the emitter always has a listener. The question has to be asked of the `Database`:

- `db.hasDataListeners()` is public, but counts only `onDataChange` listeners. A host subscribed only to `onTransactionCommit` receives data events through `batch.dataEvents`, so a module gating on `hasDataListeners()` would silently starve it.
- `db._needsDataEvents()` answers the right question — `onDataChange` OR `onTransactionCommit` listeners, and `false` inside a `withPublicEventsSuppressed` scope — but it is `@internal`, stripped from the published `.d.ts`, and named as engine-private.

## Requested change

Expose the existing `_needsDataEvents()` semantics as a public, documented `Database` method (suggested name `needsDataEvents(): boolean`), and say in `docs/module-events.md` § *For Modules with Native Events* that a native-emitter module may consult it to skip building events no one will receive. The internal callers can switch to the public name or keep the private alias — the engine's choice.

Document the timing caveat the engine's own auto-event gate already has: the answer is sampled when the module asks, so a listener that subscribes in the middle of a transaction may not see events for writes made before it subscribed.

## Lamina's interim behaviour

Lamina does not wait on this. Its adapter probes structurally: the public `needsDataEvents` if present, else the runtime `_needsDataEvents` that 4.20.x ships, else assumes `true` (prepare every event, today's behaviour). Once a release carries the public method and lamina bumps its range, lamina drops the private fallback.
