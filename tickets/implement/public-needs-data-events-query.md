description: Give modules a public way to ask a Quereus database whether anyone is listening for data-change events, so a module with its own event emitter can skip preparing events nobody will receive.
architecture: docs/module-events.md#module-integration
difficulty: easy
files:
  - packages/quereus/src/core/database.ts              # rename `_needsDataEvents` (~line 1420); JSDoc on `hasDataListeners` (~line 1402); `{@link}` in `_needsSchemaEvents` (~line 1427)
  - packages/quereus/src/core/database-events.ts       # `DatabaseEventEmitter.needsDataEvents()` (~line 496) — unchanged logic; comment only
  - packages/quereus/src/runtime/emit/dml-executor.ts  # three call sites (~lines 1150, 1432, 1621)
  - packages/quereus/src/vtab/events.ts                # `VTableEventEmitter.hasDataListeners` comment (~line 105)
  - packages/quereus/test/database-events.spec.ts      # one new test beside `should report listener status correctly` (~line 272)
  - docs/module-events.md                              # new subsection under § For Modules with Native Events
  - docs/stability.md                                  # "Database event hooks" row (~line 93)
----

Filed from the lamina board. Lamina holds one record per written row until commit so it can emit its events afterwards. On a multi-million-row import, that memory is wasted when nobody is listening.

## Design

`Database` gains a public `needsDataEvents(): boolean`. It replaces the `@internal` `_needsDataEvents()` and delegates to `DatabaseEventEmitter.needsDataEvents()`, whose logic does not change:

```typescript
needsDataEvents(): boolean {
	if (this.publicEventSuppressionDepth > 0) return false;
	return this.dataListeners.size > 0 || this.transactionCommitListeners.size > 0;
}
```

### Decisions

- **Rename, with no private alias.** The three DML executor call sites move to the public name, so only one method exists. Lamina's adapter already looks for the public name first and falls back to `_needsDataEvents` only on 4.20.x, so removing the private name in the release that adds the public one breaks nothing. The project does not keep backwards-compatibility aliases at this stage.
- **`_needsSchemaEvents` stays internal.** No module has asked for it, and schema events do not buffer per row. The asymmetry is deliberate.
- **No `checkOpen()`.** `hasDataListeners()` has none either, and a module may reasonably ask during `close()`, which calls `schemaManager.clearAll()` (and so module teardown) before `removeAllListeners()`. The method must return an answer on a closed database, not throw. After close the answer is `false`.
- **Listeners on the module's own emitter are not counted, and the engine cannot count them.** `db.getTable(...).getEventEmitter()` is a documented way to subscribe directly (docs/usage.md § Per-Table Subscription), and `packages/quereus-plugin-indexeddb/src/broadcast.ts:60` subscribes this way. The module's own `hasDataListeners()` does not separate them from the database either: `DatabaseEventEmitter.hookModuleEmitter` subscribes as soon as the module is registered, so that call returns `true` from then on. The docs must state this. A module whose emitter has direct subscribers has to track them itself before it skips anything.

### Documentation text

Add this to `docs/module-events.md` under § For Modules with Native Events, before `#### Don't hand-roll the ALTER TABLE event shape`:

````markdown
#### Skip building events no one will receive

Building an event can be expensive, and a module that holds events until commit pays for that memory on every row of the transaction. Ask the database whether anyone will receive them:

```typescript
async update(args: UpdateArgs): Promise<Row | undefined> {
  const result = await this.performUpdate(args);
  if (this.db.needsDataEvents()) {
    this.queueEvent(this.buildEvent(args, result));
  }
  return result;
}
```

`db.needsDataEvents()` is `true` when the database has an `onDataChange` or `onTransactionCommit` listener, and `false` inside an [engine-internal scope](#engine-internal-scaffolding-is-silent), where the event would be dropped anyway. Do not use `db.hasDataListeners()` for this: it counts only `onDataChange` listeners, so a host subscribed only to `onTransactionCommit` would stop receiving data events through `batch.dataEvents`. Your emitter's own `hasDataListeners()` does not help either, because the database subscribes to your emitter when the module is registered, so it stays `true`.

- **Ask on each write, or once per statement. Do not keep the answer for a whole transaction.** An engine-internal scope can close partway through a transaction, and a listener can subscribe at any time.
- **A late subscriber can miss earlier writes.** The answer describes the moment you ask, so a listener that subscribes in the middle of a transaction does not see events for writes made before it subscribed. The engine's own automatic events have the same limit: they sample once at the start of each statement.
- **It only knows about the database's listeners.** Anything subscribed directly to your emitter, including through `db.getTable(...).getEventEmitter()`, is not counted. If your emitter can have direct subscribers, track them yourself and build the event when either applies. A module instance registered with more than one `Database` must build the event if any of them needs it.
````

Check the anchor `#engine-internal-scaffolding-is-silent` against the heading `### Engine-Internal Scaffolding Is Silent` in the same file.

### JSDoc

- `Database.needsDataEvents()`: public. State what it counts (`onDataChange` or `onTransactionCommit` listeners; false inside a suppression scope), that the answer is sampled when asked, that listeners on a module's own emitter are not counted, and point to docs/module-events.md.
- `Database.hasDataListeners()`: add that it counts only `onDataChange` listeners, and refer to `needsDataEvents` for deciding whether to build events.
- `VTableEventEmitter.hasDataListeners` in `vtab/events.ts`: add that once a module is registered the database is itself a listener, so this does not tell a module whether anyone downstream is listening.
- `DatabaseEventEmitter.needsDataEvents()`: update the "consulted by" sentence to mention the public `Database.needsDataEvents`.

## Edge cases & interactions

- **Only an `onTransactionCommit` listener:** `needsDataEvents()` is `true` while `hasDataListeners()` is `false`. This is the reason the method exists. Verified by the test below.
- **Suppression scope:** returns `false`, including when nested, and recovers when the scope closes or its body throws. Already covered at the emitter layer by the `withPublicEventsSuppressed` tests in `database-events.spec.ts`; the `Database` method is a one-line delegate, so no new test is needed.
- **Mid-transaction subscribe:** behaviour is unchanged and documented, with no code. Verified by reading the doc text.
- **Listener removed mid-transaction:** events already handed to the engine flush to no one, which is harmless. No code change; verified by inspection of `flushBatch`.
- **Closed database:** returns `false` and does not throw. Verified by inspection: no `checkOpen()` call in the method, and `close()` calls `removeAllListeners()`.
- **Auto-event gate in the DML executor:** the same answer at the same three sites, with only the name changed. Verified by the existing suite.
- **Published types:** `packages/quereus/tsconfig.json` sets `stripInternal`, so the method must not carry `@internal`. Verified by inspection, or by grepping `dist/src/core/database.d.ts` for `needsDataEvents` after a build.
- **Other callers of the old name:** at planning time, `_needsDataEvents` appears only in `database.ts` and `dml-executor.ts`. Verified by `tsc` and by a repo-wide grep after the rename.

## Test

Add one test to `packages/quereus/test/database-events.spec.ts`, in the same `describe` as `should report listener status correctly`, whose `beforeEach` subscribes `onDataChange` and `onSchemaChange` listeners and exposes `unsubData` / `unsubSchema`. It pins the public contract that separates this method from `hasDataListeners`:

| Step | `db.hasDataListeners()` | `db.needsDataEvents()` |
| --- | --- | --- |
| Data listener subscribed (from `beforeEach`) | `true` | `true` |
| After `unsubData()` | `false` | `false` |
| After `const off = db.onTransactionCommit(() => {})` | `false` | `true` |
| After `off()` | `false` | `false` |

## TODO

- Rename `Database._needsDataEvents` to `needsDataEvents`, remove `@internal`, and write the JSDoc above
- Update the `{@link}` in the `_needsSchemaEvents` JSDoc
- Update the three call sites in `dml-executor.ts`
- Update the comments on `Database.hasDataListeners`, `VTableEventEmitter.hasDataListeners`, and `DatabaseEventEmitter.needsDataEvents`
- Add the test above
- Add the documentation subsection to `docs/module-events.md`
- Add `needsDataEvents` to the "Database event hooks" row in `docs/stability.md`
- Run `yarn workspace @quereus/quereus run lint` and `yarn workspace @quereus/quereus run test`
- Grep `packages` and `docs` for `_needsDataEvents`; expect no hits
