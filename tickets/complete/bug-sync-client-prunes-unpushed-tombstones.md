description: A device that deleted rows while offline for more than a month used to forget those deletions before telling the server, so the rows came back when it reconnected. Expiry now keeps any deletion the device has not yet delivered.
architecture: docs/sync.md#tombstones-and-deletions
files:
  - packages/quereus-sync/src/sync/sync-manager-impl.ts       # pruneTombstones and the isUndeliveredOwnDelete predicate
  - packages/quereus-sync/src/metadata/peer-state.ts          # getMinSentWatermark; reworded NOTE in deletePeerState
  - packages/quereus-sync/src/metadata/keys.ts                # prefixBounds now exported (not re-exported from index.ts)
  - packages/quereus-sync/src/sync/manager.ts                 # pruneTombstones doc comment
  - packages/quereus-sync/src/sync/protocol.ts                # retentionHorizonMs doc comment
  - packages/quereus-sync/test/sync/prune-unpushed-tombstones.spec.ts   # new
  - packages/quereus-sync/test/sync/_peer-harness.ts          # markAllDelivered helper
  - packages/quereus-sync/test/sync/changelog-orphan-cleanup.spec.ts
  - packages/quereus-sync/test/sync/snapshot-tombstones-and-drift.spec.ts
  - packages/quereus-sync/test/sync/snapshot-replaces-rows.spec.ts
  - packages/quereus-sync/test/sync/sync-protocol-e2e.spec.ts
  - docs/sync.md
  - docs/sync-transactions.md
repro: verified
----

## What changed

A tombstone (the record that a row was deleted) is also the only way a local delete reaches the server: `getChangesToPush` reads the change log past the sent watermark (the highest timestamp the server has acknowledged, stored per server under `pt:`) and resolves each delete entry through its tombstone. `pruneTombstones` used to remove tombstones on age alone, so a device offline past `retentionHorizonMs` lost its own undelivered deletes.

`pruneTombstones` now keeps a tombstone, whatever its age, when this replica wrote it (`tombstone.hlc.siteId` is this site) and it is not yet delivered: no `pt:` record exists, or its timestamp is above the lowest sent watermark across all `pt:` records (`PeerStateStore.getMinSentWatermark`). Everything else expires by age. Hosts need no change: `SyncMaintenanceTarget` and the quoomb-web worker are untouched.

The rule and its limits are stated once in `docs/sync.md` § Tombstones and Deletions; the other doc passages link there.

## Tests added

`prune-unpushed-tombstones.spec.ts`: the reproduction (an expired delete above the watermark is kept and still removes the row from a stand-in server), the no-watermark arm, pruning on the sweep after the watermark reaches it with the delta floor raised only then, the lowest of several watermarks, and other devices' deletes still expiring both with no watermark and with a lower one. The 9 existing tests that deleted locally and pruned with no watermark now declare the delete delivered through `markAllDelivered`.

## Review findings

Read the diff of `ticket(implement): bug-sync-client-prunes-unpushed-tombstones` before the handoff.

**Checked, no defect**

- **End to end through a real client.** The handoff said nothing ran this path, so I ran a throwaway spec (deleted afterwards) with real `SyncClient`s against a live coordinator. A device offline with a two-row delete in one transaction keeps both through a prune, the delete reaches the server and a second device after reconnecting, and a prune after the real ack removes both. In a second run the server had raised its delta floor, the client went through `handleSnapshotRequired` (asserted by counting calls), and the delete was on the server and the device stayed deleted after the snapshot; the next prune removed it. The quoomb-web worker was not run, but it hands the same `SyncManager` to `SyncClient` and to the maintenance pass, so the ack and the prune read one `pt:` store.
- **The watermark covers whole transactions.** `ChangeSet.hlc` is the maximum over the group (`maxGroupHLC`), and the client promotes to the maximum across the batch, so a multi-row delete does not leave later facts above the watermark.
- **`markAllDelivered` and `MAX_OPSEQ`.** The handoff's reasoning came from reading only. Confirmed by reading `HLCManager.now()`: it does not tick and returns `opSeq` 0, so `MAX_OPSEQ` is needed.
- **Handoff's "delivered means what the push read means" gap.** A forwarded held change cannot put the watermark above a later own write: `admission.ts` merges inbound timestamps into the local clock, so own writes after receipt stamp higher. Read, not tested.
- **Other claims.** The coordinator wires no transaction source (`store-manager.ts`), and all tombstone writes there carry the origin's timestamp, so the rule never matches on it. `pt:` is written only on a correlated ack (`sync-client.ts`). A late delete is dated now on apply (`change-applicator.ts` passes no `createdAt`). `TombstoneStore.pruneExpired` also expires on age alone, but has no production caller and already carries a `NOTE:` saying so; left alone.
- **Docs.** Read the diff to `docs/sync.md` and `docs/sync-transactions.md`, then searched those two plus `docs/migration.md`, `docs/sync-coordinator.md`, `docs/lens.md`, `docs/todo.md` and the sync and coordinator READMEs for tombstone expiry and the retention horizon, reading the lines that matched rather than each file in full. The matching passages are updated or still accurate.
- **Regressions.** The delta floor rises only for tombstones actually pruned, and `getChangesToPush` has no floor check, so a floor raised by an expired foreign delete cannot block a kept own delete. A device that never synced and has only kept tombstones is no longer read as empty by `isReplicaEmpty`, which is the safer answer.
- **Error handling and resources.** A corrupt `pt:` record makes `pruneTombstones` throw before it writes anything; `runSyncMaintenancePass` isolates each sweep, so that is logged and the rest run. Nothing to clean up.
- **Type safety and size.** No new casts. `sync-manager-impl.ts` was already over 2000 lines and this adds about 25; not a new concern.

**Minor, fixed in this pass**

- The comment in `pruneTombstones` said a watermark only rises, so a stale read keeps more. That is true per peer, not of the minimum, which falls when a new server's first record appears. Reworded to "each peer's watermark".
- The first-met-server limit in `getMinSentWatermark` was not tagged, so it would not show up in a sweep of `NOTE:`s. See tripwires.

**Tests**

- Kept all new tests. The two "another device's expired delete" cases hit the same branch today, but they are different real devices (receive-only, and one that also pushes), and a rewrite that scoped the own-tombstones check to one arm would pass with only one of them.
- No tests added: the end-to-end paths above passed, so a permanent e2e would only repeat the lower-level reproduction at higher run cost.
- Not changed: `deleteAndPrune` asserts only "more than zero". With the `opSeq` reasoning confirmed, a partial prune would need a new defect in the helper.

**Major:** none. No tickets filed.

**Tripwires (conditional; parked at the site)**

- A server met for the first time is not counted, so own tombstones below the minimum can prune before it has them. `NOTE:` at `PeerStateStore.getMinSentWatermark`; applies only if one database syncs to several servers.
- A replica that never pushes keeps its own tombstones forever. `NOTE:` at `pruneTombstones`, from the implement stage.
- A leftover `pt:` record holds the minimum down. `NOTE:` at `deletePeerState`, from the implement stage.

**Validation**

`@quereus/sync` 845 passing, run before the two comment-only edits. `@quereus/sync-client` 106 passing and `@quereus/sync-coordinator` 138 passing, run after the first edit and before the second. `yarn workspace @quereus/sync run typecheck` ran after both edits. `yarn lint` for `@quereus/sync` is a no-op. Not run: the full `yarn test` across all workspaces, `yarn build`, and the quoomb-web tests, although the quoomb-web worker calls this code.
