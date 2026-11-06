description: If a device edits a row while an incoming sync change to that row is being applied, the device's row and sync's records can disagree, so the device serves the wrong value and never sends its own edit. The local edit should win (it happened after the change arrived), and the row and records should always agree.
prereq: sync-serialize-applies
architecture: docs/sync-transactions.md#transactional-integrity-during-sync
files:
  - packages/quereus-sync/src/sync/change-applicator.ts # applyChanges: drift check + pre-resolution whenCommitsSettled (~312-326), Phase 1 resolveChange, commitMetadata (~504); commitChangeMetadata / fileAtNextTick / commitColumnMetadata / commitDeleteMetadata (~1326-1630)
  - packages/quereus-sync/src/sync/sync-manager-impl.ts # enqueueTransactionCommit (~861) runs synchronously at engine commit; recordCommitBatch / recordDataEvent decide which cells local capture records
  - packages/quereus-sync/src/sync/store-adapter.ts # createStoreAdapter: storage writes (applyExternalRowChanges, ~227-265) run outside the exec mutex, then ingestExternalRowChanges takes it (~287)
  - packages/quereus-sync/src/sync/protocol.ts # ApplyToStoreOptions (~578)
  - packages/quereus-sync/src/sync/sync-context.ts # SyncContext: add the local-write tracker accessor
  - packages/quereus/src/core/database-external-changes.ts # ingestExternalRowChangeBatch acquires the exec mutex (~142)
  - packages/quereus/src/core/database.ts # ingestExternalRowChanges (~3283)
  - docs/sync-transactions.md # § Filing position, § Transactional Integrity During Sync
  - docs/mv-ingestion.md # the new storage-write-under-the-mutex entry point
difficulty: hard
repro: verified
----

## What goes wrong

An apply decides each incoming cell against the stored cell record in Phase 1, writes rows in Phase 2 (store adapter), and files cell records in Phase 3 (`fileAtNextTick`, an entry on the commit chain). Local DML is not ordered against any of that. The engine commits a local edit whenever it gets the exec mutex. Its capture (`recordCommitBatch`) runs later, on the commit chain, and ticks the clock there.

A local edit that commits after the apply read the cell's record therefore races the apply twice: on the row (whichever data write lands last stays) and on the record (whichever filing lands last stays). Neither outcome is decided by timestamps, and the apply files with the `oldColumnVersion` it read in Phase 1, so the capture's change-log entry is never removed. That entry then points at a record filed at a different position. The read side treats it as stale and skips it, and `repairChangeLog` later deletes it.

### Reproduction (run, real engine + store adapter)

The receiver was built like `makePeer` (`test/sync/_peer-harness.ts`) with `applyToStore` wrapping `createStoreAdapter`'s callback, so a local `update orders set qty = 2 where id = 1` can run either just before the real adapter call (**window A**) or just after it (**window B**). Incoming changes are hand-built `ChangeSet`s, so the sender's timestamp can be placed 5 s behind or ahead of the receiver's clock. Table: `create table orders (id integer primary key, note text, qty integer) using store`.

| Case | Row `qty` | Record `qty` | Pushed | Served | Stale log entries |
|---|---|---|---|---|---|
| new row (incoming `qty 1`), window B, sender behind | 2 | 1 (sender) | — | 1 | 2 |
| new row, window B, sender ahead | 2 | 1 (sender) | — | 1 | 2 |
| existing row (incoming `qty 5`), window B, sender behind | 2 | 5 (sender) | — | 5 | 1 |
| existing row, window B, sender ahead | 2 | 5 (sender) | — | 5 | 1 |
| existing row, window A, sender behind | 5 | 5 (sender) | — | 5 | 1 |
| existing row, window A, sender ahead | 5 | 5 (sender) | — | 5 | 1 |

Window B always diverges: the row says 2, the record and everything served say the incoming value, and the local edit is sent nowhere. Window A agrees with itself but drops the local edit everywhere, even when the edit was the newer write ("sender behind").

Fixing only the filing step makes things worse. If filing drops a fact because the stored record is newer, window B is fixed but window A diverges: the row keeps the incoming value from the data write while the record keeps the local edit. Both the data write and the filing have to honour the same decision.

## Intended behaviour

A local edit that commits while an apply is in flight was made after this device received the batch. By the usual last-writer-wins rule (hybrid logical clock causality) it is newer than every change in that batch, so it wins every cell it changed. The incoming changes to those cells are not applied and not filed. Every other cell of the batch applies as usual. The row and its records agree, the local edit's records keep their change-log entries, and the edit is pushed.

An incoming **delete** still beats concurrent local column edits. `resolveChange` compares a delete only with tombstones, and the existing delete cleanup removes the row's cell records. A local **delete** in the window beats the incoming changes to that row: column changes are skipped, and an incoming delete is redundant (the local tombstone is newer).

## Design

Four parts. Each one is needed; the reasons are given after the table.

**1. Merge the batch's clock early.** In `applyChanges`, call `ctx.hlcManager.receive(watermarkHLC)` right after the drift check and *before* the pre-resolution `await ctx.whenCommitsSettled()`. Any local commit whose capture Phase 1 did not see then ticks above every fact in the batch, because it is captured after that wait. Today the merge happens inside `fileAtNextTick`, so a local capture during the apply can tick below the sender's timestamp. Keep the merge in `fileAtNextTick` too (it is idempotent, and it is what the drain path relies on). Keep persisting the clock in the filing write. If the process crashes before that write, only an in-memory advance is lost, which is harmless. Drop the "on a mid-batch abort the clock does not advance" wording from the `commitMetadata` comment and the docs. No test depends on it (checked: `grep -rn "not advance" packages/quereus-sync/test`).

**2. Track local writes during the apply.** `SyncManagerImpl.enqueueTransactionCommit` runs synchronously inside the engine's commit (`flushBatch` in `database-events.ts`, under the exec mutex, after the storage commit). There, before chaining the capture, record the cells each local (non-`remote`) data event changes into every registered tracker:

- update: the columns whose values differ between `oldRow` and `newRow`. Use the same comparison local capture uses to decide which cells to record. Share one helper rather than writing a second diff.
- insert: every column.
- delete: the row (a deletion mark).
- primary-key-changing update: a delete of the old key plus an insert of the new key.

Key the cells by pk identity (`ctx.getPkKeying` / `encodePkIdentity`, as `rowIdentityKey` does) plus column. An apply registers its tracker at step 1 (before the merge, so no commit can fall between them) and unregisters it in a `finally` once filing has read it. Expose it to the apply through `SyncContext`.

**3. The data write skips tracked cells, atomically.** The store adapter's storage writes (`buildRowOp` + `StoreTable.applyExternalRowChanges`) currently run outside the exec mutex, before `db.ingestExternalRowChanges` takes it. A local statement can commit between the adapter's read and its write. To fix this:

- Add an engine entry point that runs a caller's storage-write callback and then the ingestion pipeline under **one** exec-mutex hold. For example, `ingestExternalRowChanges` could accept a `write: () => Promise<readonly ExternalRowChange[]>` callback whose result becomes the batch, or there could be a sibling method; pick the shape that reads best next to the existing API.
- In the adapter, run the per-table storage loop inside that callback.
- Add an optional predicate to `ApplyToStoreOptions`, e.g. `supersededLocally?(schema, table, pk, column | undefined): boolean`. With `column` undefined it means "the row was deleted locally". The apply supplies it from its tracker.
- Inside the callback, the adapter drops each incoming column value whose cell the predicate reports, before building the row op. A row left with no columns produces no op.

While the mutex is held no local commit can land, so the check and the write are atomic. Commits that landed earlier are already in the tracker, because the tracker is filled synchronously inside the commit. Document the new option in `protocol.ts`: a host-supplied `applyToStore` that ignores it keeps today's behaviour.

The schema phases (`applySchemaPhase`, which runs `db.exec`) stay outside this hold, since they take the mutex themselves. A bootstrap flush skips the seam today. It can use the same entry point with the pipeline off, or keep its current path, because snapshots do not carry the tracker. Say which you chose.

**4. Filing drops the same cells and re-reads the rest.** Inside `fileAtNextTick`, which runs on the commit chain so no capture runs at the same time:

- Drop every column fact whose cell is tracked, and every column or delete fact of a row the tracker marks deleted.
- For each remaining fact, re-read the stored cell record or tombstone. Use it, not Phase 1's snapshot, as `oldColumnVersion` / `oldTombstone`, both for removing the old change-log entry and for the before-image. This is needed because capture records *every* column on the first edit of a row sync has no records for. In the ticket's own case (new row, window B), capture records `note` too, at the local timestamp and with the incoming value. The incoming `note` fact is untracked, so it files over that record, and it must remove the capture's entry for it. The values agree, so either timestamp is fine.
- Read the tracker synchronously when the entry starts. A commit landing after that point is captured after the filing (chain order), and it overwrites the filed record with a newer one, removing the filed entry via its own lookup. Its row write also comes after the data write. Both end up correct.

Return the dropped facts to `applyChanges`. Count them as conflicts rather than applied, and leave them out of `emitRemoteChanges`, so `ApplyResult` and `onRemoteChange` describe what actually landed. The delete cleanup loop in `commitChangeMetadata` must skip dropped deletes.

### Why each part is needed

| Local commit lands… | Row after | Record after | Needs |
|---|---|---|---|
| before Phase 1 reads the cell | local | local (Phase 1 sees it; incoming loses) | 1 (otherwise the incoming change can win against a local edit made after receipt) |
| after Phase 1, before the data write (window A) | local, because the adapter skips the cell | local, because filing drops the fact | 1, 2, 3, 4 |
| after the data write, before filing reads the tracker (window B) | local | local, because filing drops the fact | 1, 2, 4 |
| after filing read the tracker | local | local, because the capture overwrites | 1 |

Without step 1, a local timestamp can be below the incoming one in the last three rows. Then "the local edit wins" breaks last-writer-wins across devices: the sender would keep its own newer value while this device keeps the local one.

### Known limits (record as `NOTE:` at the tracker)

- An explicit local transaction that **reads** a row before the data write and **commits** after it writes its full stale row image back through the store's transaction coordinator. That clobbers the batch's untracked cells of that row (for example `note`), while filing records the incoming values. The adapter already documents that hosts must not drive an apply inside their own open transaction. This is the concurrent version of the same thing. If it ever matters, the tracker would have to mark every cell of a row written by a transaction that was open across the data write.
- Capture's "first edit of a row sync has no records for" records all columns, but step 2 tracks only the changed ones. In window A on an *unrecorded* existing row, an incoming value for an unchanged column is written to the row (untracked) and filed over the capture's record (step 4 re-reads it). They agree, so this is fine. Note it so nobody "fixes" the tracker to record all columns, which would make the adapter skip cells that filing then files.

## Reproduction tests

Put these with `sync-serialize-applies`' overlapping-apply test (e.g. `test/sync/concurrent-apply.spec.ts`). The receiver helper:

```ts
async function makeReceiver(hook: { before?: () => Promise<void>; after?: () => Promise<void> }) {
	const { provider } = createInMemoryProvider();
	const events = new StoreEventEmitter();
	const db = new Database();
	const storeModule = new StoreModule(provider, events);
	db.registerModule('store', storeModule);
	const real = createStoreAdapter({ db, storeModule, events });
	const applyToStore: ApplyToStoreCallback = async (data, schema, options) => {
		const before = hook.before; hook.before = undefined;
		if (before) await before();
		const result = await real(data, schema, options);
		const after = hook.after; hook.after = undefined;
		if (after) await after();
		return result;
	};
	const manager = await SyncManagerImpl.create(
		new InMemoryKVStore(), db, { ...DEFAULT_SYNC_CONFIG }, new SyncEventEmitterImpl(), applyToStore,
		(s, t) => db.schemaManager.getTable(s, t), undefined, db.getKeyNormalizerResolver(),
	);
	await db.exec('create table orders (id integer primary key, note text, qty integer) using store');
	await settle();
	return { db, manager };
}
```

Once step 3 lands, the `before` hook runs outside the mutex. A local `db.exec` there still commits before the adapter's write, which is what window A needs.

Cases, each with the incoming sender timestamp 5 s **behind** and 5 s **ahead** of `Date.now()` (step 1 must make the local edit win in both):

- new row (incoming insert `note 'one'`, `qty 1`), local `update … qty = 2` in `after`;
- existing row (insert at `now − 20s`, then incoming `qty 5` with `priorHlc`/`priorValue` of the insert's `qty`), local update in `before`;
- the same existing row, local update in `after`.

Assert, after `settle()`: the row's `qty` is 2; the stored `qty` record has value 2 with this site's `siteId`; `getChangesToPush(otherPeer)` carries `qty = 2`; `repairChangeLog()` returns 0. For the new-row case also assert the row's `note` is `'one'` and its record's value is `'one'`.

One more case: a local `delete from orders where id = 1` in `before` against an incoming `qty` change. Expect no row, a tombstone, no `qty` record, and `repairChangeLog() === 0`.

These are seven tests covering one behaviour across windows and clock orders. A table-driven `for` over the cases keeps them as one block.

## TODO

- Step 1: move the watermark merge ahead of the pre-resolution `whenCommitsSettled` in `applyChanges`; fix the `commitMetadata` comment.
- Step 2: tracker registry in `SyncManagerImpl` filled in `enqueueTransactionCommit` (synchronous part), with the changed-cells helper shared with local capture; exposed via `SyncContext`; registered and unregistered by `applyChanges` (try/finally).
- Step 3: engine entry point running a storage-write callback plus the ingestion pipeline under one exec-mutex hold; the store adapter moves its per-table storage loop into it; `ApplyToStoreOptions.supersededLocally` honoured there.
- Step 4: `fileAtNextTick` drops tracked facts, re-reads the stored record or tombstone for the rest, and returns the dropped facts; `applyChanges` adjusts counts and `emitRemoteChanges`; delete cleanup skips dropped deletes.
- `NOTE:`s for the two known limits at the tracker.
- Reproduction tests above.
- Docs: `docs/sync-transactions.md` § Filing position and § Transactional Integrity During Sync (local edits during an apply win their cells; the data write and filing honour one decision); `docs/mv-ingestion.md` (the new entry point; the "do not call from within statement execution" rule still applies).
- `yarn build`, `yarn workspace @quereus/sync test`, `yarn workspace @quereus/quereus test` (engine change), and `yarn lint` for the engine package.

Related, not merged: `bug-sync-local-create-during-replicated-drop-loses-bookkeeping` (backlog) is the same kind of race for table identity (a local create during a replicated drop). It resolves at the identity-transition step in `commitMetadata`, not at the cell filing.
