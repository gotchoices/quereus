description: When two incoming sync batches change the same cell at the same time on one device, the device's row can end up with one value while sync's records keep the other, older one; incoming batches should be applied one at a time.
architecture: docs/sync-transactions.md#transactional-integrity-during-sync
files:
  - packages/quereus-sync/src/sync/sync-manager-impl.ts # applyChanges / drainHeldChanges (~1956), trackApply (~898), recordLensDeployment's deferred drain (~783), appliesDrained (~1993)
  - packages/quereus-sync/src/sync/change-applicator.ts # applyChanges: Phase 1 resolves outside any lock; commitChangeMetadata files the stale decision
  - packages/quereus-sync/test/sync/late-arrival-delta.spec.ts # 'applies that overlap on one replica' (~214) relies on two applies overlapping
  - docs/sync-transactions.md # § Filing position ("An apply's data writes are not serialized")
difficulty: medium
repro: verified
----

## Problem

An apply (`applyChanges`, and the held-change drain `drainHeldChanges`) decides each incoming cell against the cell's stored record in Phase 1, then writes the row (Phase 2), then files its records (Phase 3, `commitChangeMetadata` → `fileAtNextTick` on the commit chain). Nothing stops a second apply from doing all three steps between the first apply's decision and its filing. The first apply then files the decision it made against a record that no longer exists:

- it overwrites the newer record without comparing timestamps, and
- the change-log entry it should have replaced (the second apply's) stays behind, pointing at a record filed at another position, so readers skip it.

Reproduced in-process with the real store adapter (receiver built like `makePeer` in `_peer-harness.ts`, with `applyToStore` wrapped so one apply can be paused after its data write):

1. Insert `(1, 'one', qty 1)` from writer W at `now − 20s`.
2. Apply A: `qty = 5` from W at `now − 10s`. Pause it after its data write.
3. Apply B: `qty = 7` from W at `now − 5s`. Runs to completion.
4. Release A.

Result: row `qty = 7`, cell record `qty = 5` (the older value), `getChangesSince` serves `qty = 5`, `repairChangeLog` removes 1 stale entry. Expected: row and record both `7`.

The row ends with whichever apply wrote data last, the record with whichever filed last; the timestamps never decide either.

## Fix

Run applies one at a time on a manager. A FIFO queue in `SyncManagerImpl` around every entry point that runs an apply: `applyChanges`, `drainHeldChanges`, and the deferred/inline drains `recordLensDeployment` starts through `trackApply`. Each runs only after the previous one has settled (success or failure; a failed apply must not block the queue). `appliesInFlight` / `whenAppliesSettled` / `appliesDrained` keep their meaning (adoption still waits for the queue to empty before joining the commit chain).

Not a lock against local writes; local commits during an apply are the subject of `bug-sync-local-edit-during-apply-diverges`, which builds on this ticket (its filing rule assumes no other apply can file between its decision and its filing).

Constraints:

- Internal calls stay off the queue. `applyChanges` already calls `drainReappearedTables` → the change-applicator's own `drainHeldChanges` function, not the manager method; keep it that way. Waiting on the queue from inside an apply deadlocks. Put a `NOTE:` at the queue saying so.
- `recordLensDeployment` defers its drain when `db._isExecuting()` because the drain needs the exec mutex. Queuing it is fine (the queue doesn't hold the mutex), but the inline `await` branch must not run inside an apply. Check that no apply path reaches `recordLensDeployment` (the store adapter's replicated DDL runs `db.exec(change.ddl)`; confirm a replicated migration can never be `apply schema`).
- Snapshot application (`applySnapshot`, `applySnapshotStream`) is out of scope unless it is trivial to put it on the same queue; say what you chose in the review handoff.

The doc's "An apply's data writes are not serialized" (§ Filing position) becomes false for applies; update that paragraph. Filing must still run on the commit chain: that orders it against local capture, which this ticket does not change.

`late-arrival-delta.spec.ts` › 'applies that overlap on one replica' awaits a second apply while the first is paused, so it will hang once applies queue. Its subject (positions follow commit order when applies overlap) no longer arises between applies. Replace it with the reproduction below, which pins the new behaviour; delete it rather than keep a test of a case that cannot occur.

## Reproduction test

Add to an existing sync spec (or a new `test/sync/concurrent-apply.spec.ts` shared with `bug-sync-local-edit-during-apply-diverges`). With the queue, apply B cannot start until A finishes, so the test must not `await` B before releasing A:

```ts
// receiver: real Database + StoreModule + createStoreAdapter, applyToStore wrapped:
//   const applyToStore: ApplyToStoreCallback = async (data, schema, options) => {
//     const result = await real(data, schema, options);
//     const after = hook.after; hook.after = undefined; if (after) await after();
//     return result;
//   };
// table: create table orders (id integer primary key, note text, qty integer) using store
it('a newer apply started during an older one ends with the newer value in the row and the record', async () => {
	await manager.applyChanges([insertSet(writer, now - 20000n, 1)]);
	hook.after = async () => { reached(); await gate; };
	const older = manager.applyChanges([qtySet(writer, now - 10000n, 5, prior)]);
	await reachedP;
	const newer = manager.applyChanges([qtySet(writer, now - 5000n, 7, prior)]);
	release();
	await Promise.all([older, newer]);
	expect(rows[0].qty).to.equal(7);
	expect((await manager.columnVersions.getColumnVersion('main', 'orders', [1], 'qty'))?.value).to.equal(7);
	expect(await manager.repairChangeLog()).to.equal(0);
});
```

`insertSet` / `qtySet` build hand-made `ChangeSet`s (one column change per cell, `createHLC(wall, 0, writer, opSeq)`; the update carries `priorHlc`/`priorValue` of the insert's `qty`).

## TODO

- Add the apply queue to `SyncManagerImpl`; route `applyChanges`, `drainHeldChanges` and `recordLensDeployment`'s drains through it; keep `trackApply`'s settled-tracking semantics for adoption.
- `NOTE:` at the queue: never wait on it from inside an apply.
- Replace the overlapping-applies test in `late-arrival-delta.spec.ts` with the reproduction above.
- Update `docs/sync-transactions.md` § Filing position (applies no longer overlap; filing stays on the commit chain to order against local capture).
- `yarn workspace @quereus/sync test` (check the package name in `packages/quereus-sync/package.json`) and `yarn build`.
