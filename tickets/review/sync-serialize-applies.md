description: Incoming sync batches on one device are now applied one at a time, so two batches changing the same cell can no longer leave the row with one value and sync's records with another.
architecture: docs/sync-transactions.md#transactional-integrity-during-sync
files:
  - packages/quereus-sync/src/sync/sync-manager-impl.ts # applyQueue field (~285), enqueueApply (~907), applyChanges / drainHeldChanges (~1970), recordLensDeployment's drains (~790), appliesDrained (~2008)
  - packages/quereus-sync/src/sync/sync-context.ts # whenAppliesSettled doc
  - packages/quereus-sync/src/sync/change-applicator.ts # fileAtNextTick doc comment only
  - packages/quereus-sync/test/sync/concurrent-apply.spec.ts # new; reproduction test + receiver helper meant to be shared with bug-sync-local-edit-during-apply-diverges
  - packages/quereus-sync/test/sync/late-arrival-delta.spec.ts # removed 'applies that overlap on one replica'
  - docs/sync-transactions.md # § Filing position: new "Applies run one at a time" paragraph, rewritten "Commit order equals position order"
----

## What changed

`SyncManagerImpl` now has a FIFO apply queue (`applyQueue`, appended to by `enqueueApply`). It has the same shape as `onCommitChain`: each entry starts after the previous one settles, and a failed entry passes its failure to its caller without blocking the queue. These entry points go through it:

- `applyChanges`
- `drainHeldChanges` (the manager method used by maintenance and the quoomb-web local-create drain)
- both branches of `recordLensDeployment`'s reactive drain (the deferred `void` branch and the inline `await` branch)

`trackApply` / `appliesInFlight` are gone. `whenAppliesSettled()` returns the queue tail, and `appliesDrained()` loops on it, so adoption still waits for the queue to empty before it joins the commit chain. Internal drains stay off the queue: `applyChanges` → `drainReappearedTables` → the change-applicator's own `drainHeldChanges` function, as before. A `NOTE:` at the field says never to wait on the queue from inside an apply.

Filing (`commitChangeMetadata` → `fileAtNextTick`) still runs on the commit chain. Local capture takes its clock tick inside its own chain entry, so the chain is what orders apply positions against local positions. The doc and the `fileAtNextTick` comment now give that as the reason, instead of "another apply could overtake".

## Re-entrancy checks done

- Nothing reachable from inside an apply calls the manager's `applyChanges` / `drainHeldChanges` / `whenAppliesSettled`. `whenAppliesSettled` is only used by `unrecorded-rows.ts` (adoption), which runs outside applies.
- `recordLensDeployment` inside an apply: replicated DDL is per-object canonical DDL (`create table`, `alter table`, `create index`, …), taken from the schema-change event and never the `apply schema` statement. Even a malformed `ddl: 'apply schema x'` runs through `db.exec`, so `_isExecuting()` is true and the deferred `void` branch is taken, which cannot deadlock. The inline `await` branch is reachable only outside a statement. A comment there now says so.
- Sync events (`onRemoteChange`, etc.) are emitted synchronously and not awaited. The engine's post-commit watch dispatch for ingested rows does not await handlers either (`database-watchers.ts`). So a host listener that calls `applyChanges` queues behind the current apply; it does not deadlock it.
- The sync client's `handleMessage` is not serialized, so a `push_changes` apply that waits on the queue cannot hold up later websocket messages.

## Snapshot application: left off the queue (by choice)

`applySnapshot` / `applySnapshotStream` are not queued, and a `NOTE:` at the queue records this. Reasons:

- `applySnapshotStream` lasts as long as the network transfer. Queuing it would hold every pushed broadcast for the whole bootstrap.
- Queuing it needs care with the ordering: the snapshot must wait on `adoptionsInFlight` *before* it enqueues. Waiting inside the queue entry deadlocks, because adoption waits on `appliesDrained`.

So a delta apply can still overlap a snapshot apply, exactly as before this ticket. If that overlap matters, a separate ticket can make the call.

## Behaviour change to be aware of

Throughput: one manager now applies one batch at a time. On a busy coordinator, concurrent client pushes to one database used to overlap in resolve and data write (filing was already serialized). Now they queue. Recorded as a `NOTE:` tripwire at the queue (serialize per table if latency ever shows up).

## Tests

- Added `test/sync/concurrent-apply.spec.ts` › 'applies on one replica' › 'a newer apply started during an older one ends with the newer value in the row and the record'. It is the reproduction. The receiver has a real Database, StoreModule and store adapter, with `applyToStore` wrapped by one-shot `before`/`after` hooks. The older apply (`qty 5`, now−10 s) is held after its data write, and the newer one (`qty 7`, now−5 s) is started but not awaited. The test asserts:
  - the row still reads 5 after a 25 ms settle, so the newer apply did not run while the older one was in flight;
  - after release, the row is 7 and the `qty` record is 7;
  - `repairChangeLog()` returns 0.

  I checked it against the old behaviour by temporarily calling `applyChangesImpl` directly from `applyChanges`. Without the queue it fails on the first assertion. Before I added that assertion, it failed on `repairChangeLog() === 1`: with B not awaited before the release, the interleaving files A first and B second, and that leaves A's change-log entry stale. The `before` hook is unused here; it is there for `bug-sync-local-edit-during-apply-diverges`, which plans to add its window-A/B cases to this file.
- Removed `late-arrival-delta.spec.ts` › 'applies that overlap on one replica'. It awaited a second apply while the first was paused, so it would hang under the queue, and the case it tested can no longer happen between applies. Its unused imports were removed as well.

## Validation run

- `yarn workspace @quereus/sync test`: 869 passing
- `yarn workspace @quereus/sync-client test`: 118 passing
- `yarn workspace @quereus/sync-coordinator test`: 141 passing
- `yarn workspace @quereus/sync typecheck`: clean
- `yarn build`: clean

## For the reviewer

- `adoptOnCommitChain` relies on "no `await` between the wait and the append". The `await this.appliesDrained()` return already gives up a microtask before the append. That was true before this ticket too, and I did not change it.
- `docs/sync-unknown-tables.md` (Loop-free bullet) still says "two concurrent applies of one change cannot both see it absent" because of the commit-chain lookup. That is still true, and the queue now also rules it out, so I left it alone.
