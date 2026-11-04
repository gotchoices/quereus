description: A device that deletes rows while offline and stays offline for more than a month forgets those deletions before it can tell the server, so the rows come back when it reconnects. Expiry must keep any deletion the device has not yet delivered.
architecture: docs/sync.md#tombstones-and-deletions
files:
  - packages/quereus-sync/src/sync/sync-manager-impl.ts       # pruneTombstones (~2006): add the keep rule. getChangesToPush (~1532) is the read that needs the tombstone
  - packages/quereus-sync/src/metadata/peer-state.ts          # add the minimum sent watermark over the pt: range; correct the NOTE in deletePeerState
  - packages/quereus-sync/src/sync/manager.ts                 # pruneTombstones doc comment (~193)
  - packages/quereus-sync/test/sync/changelog-orphan-cleanup.spec.ts    # existing tests to adjust
  - packages/quereus-sync/test/sync/snapshot-tombstones-and-drift.spec.ts
  - packages/quereus-sync/test/sync/snapshot-replaces-rows.spec.ts
  - packages/quereus-sync/test/sync/sync-protocol-e2e.spec.ts
  - packages/quereus-sync/test/sync/_peer-harness.ts
  - docs/sync.md
  - docs/sync-transactions.md
repro: verified
----

## The bug

A tombstone is the record that a row was deleted, and also the only way a local delete reaches the server: `getChangesToPush` reads the change log past the device's sent watermark (the highest timestamp the server has acknowledged, stored under the `pt:` key per server) and resolves each delete entry through its tombstone. `pruneTombstones` removes a tombstone on age alone (`retentionHorizonMs`, 30 days by default). So a device that stays offline past the horizon removes its own undelivered deletes, and its next push does not contain them.

The browser replica hits this because the quoomb-web worker (`startSyncMaintenance`) runs the full maintenance pass, including while disconnected.

## Reproduction

Ran as a throwaway spec (deleted) using `makePeer` from `_peer-harness.ts`, with a device and a server stand-in that both have `orders`:

| Scenario | Tombstones pruned | Pushable changes | Server rows | Device rows after taking a server snapshot |
|---|---|---|---|---|
| Insert, push, delete offline, prune, horizon `-1` (expired) | 1 | `[]` | 1 | 1 (the deleted row is back) |
| Same, horizon 60 seconds (control) | 0 | `["delete"]` | 0 | 0 |
| Insert and delete with no push ever, prune, horizon `-1` | 1 | `[]` | not checked | not checked |

The reproduction test for this ticket is the first row: after the prune, `getChangesToPush(serverId, sentWatermark)` must still return the delete.

## The fix

`pruneTombstones` keeps a tombstone, whatever its age, when **this replica wrote it** (`tombstone.hlc.siteId` is this site) and it is **not yet delivered**: there is no sent watermark at all, or its timestamp is above the minimum sent watermark across all `pt:` records. Everything else expires by age as it does today.

```ts
// PeerStateStore: undefined when this replica has never had a push acknowledged.
getMinSentWatermark(): Promise<HLC | undefined>;

// SyncManagerImpl.pruneTombstones, read once before the scan.
// Own tombstone && (no watermark || compareHLC(tombstone.hlc, watermark) > 0) => keep.
```

Why each part of the rule:

- **Own tombstones only.** `getChangesToPush` sends only what this device wrote, and a device that only receives never gets a sent watermark. A rule over all tombstones would keep other devices' deletes forever on such a device.
- **Minimum across peers.** A replica can push to more than one server. A tombstone can go only when all of them have it.
- **The server is unaffected.** The coordinator wires no transaction source (`store-manager.ts` ~414), so it has no tombstones of its own and this rule never matches there. The ticket's earlier worry about telling a server with no watermark from a device with no watermark goes away with the own-tombstones scope.
- **The delta floor needs no change.** It is raised only for tombstones actually pruned, and it moves forward only.
- **Reading the watermark once, before the scan, is safe.** The watermark only rises, so a stale value keeps more, never less. It advances only on the server's acknowledgement, so a push in flight during a sweep does not count as delivered.

The prototype had one more condition, pruning an own tombstone of a dropped table (which cannot be pushed). Leave it out: dropping a table already deletes its tombstones (`TableIdentityStore.retire`), so only rare leftovers reach this code, and they cost a few bytes until the next own write moves the watermark past them.

**Rejected alternative:** a "do not prune above" value passed in by the host from its sync client. The library stays simpler, but every host must remember to pass it, and one that forgets loses data silently. The library rule fails towards keeping data, and hosts need no change: `SyncMaintenanceTarget` and the worker stay as they are.

**Checked by prototype, since reverted.** With the rule in place all three reproduction scenarios gave the correct result (rows 1 and 3 pushed the delete, and the device kept no row after the snapshot). The `@quereus/sync` suite had 835 passing and 7 failing; the 7 are listed below. The sync-client and coordinator suites were not run against it.

A delete that arrives late does get a full retention period on the server, because `setTombstoneBatch` stamps `createdAt` with the current time on apply. Only a re-keyed tombstone carries its old time over. This comes from reading the code.

## Existing tests this changes

These 7 tests delete locally and prune with no watermark, so each expects behaviour the fix removes. In all of them the replica stands in for a relay or sender, or the test is about pruning itself, so they should declare the delete delivered rather than change their assertions. A small helper in `_peer-harness.ts` can do it, calling `manager.updatePeerSentState(someSiteId, manager.getCurrentHLC())` before the prune.

- `changelog-orphan-cleanup.spec.ts` lines 110, 125, 138, 442 (the `local deletes` tests)
- `snapshot-tombstones-and-drift.spec.ts` lines 92, 116
- `sync-protocol-e2e.spec.ts` line 1732 (`should prune expired tombstones`)

Two more **still pass but no longer test what they claim**: `snapshot-replaces-rows.spec.ts` lines 24 (`deleteAndPrune`, documented as "no record of the row remains anywhere") and 182. Update them too.

`pruneEveryTombstone` in `sync-coordinator-roundtrip.e2e.spec.ts` prunes on the server's manager, and `edit-of-forgotten-row.spec.ts` line 56 on a server that applied the delete, so neither should change.

## Limits to record

Add these as `NOTE:` comments at the named site:

- `pruneTombstones`: a replica that writes locally but never pushes (a `readOnly` client, a peer others only pull from, a device that never connects) keeps its own tombstones forever. The growth is one record per own delete, not measured. If that shows up, add a way for the host to declare the replica has no upstream.
- `PeerStateStore.deletePeerState`: the existing `NOTE:` says a leftover `pt:` record is inert. That stops being true: a server the device no longer talks to holds the minimum down, so own tombstones stop expiring. Reword it. The cost is storage only.

## Not in this ticket

Pushing the delete reaches the server, but a third device that was offline during the push and whose received watermark is already past the delete's timestamp still will not get it. That is filed as `backlog/bug-sync-late-push-skipped-by-newer-watermark`, with its own reproduction. The third device's copy of the row is unchanged by this fix either way.

## TODO

- Add `PeerStateStore.getMinSentWatermark()` over the `pt:` prefix (`SYNC_KEY_PREFIX.PEER_SENT_STATE`), sharing the prefix-bounds code with `getAllPeers` rather than copying it
- Add the keep rule to `pruneTombstones` as a small private predicate, and update its doc comment and the one in `manager.ts`
- Add the two `NOTE:`s above
- Add a spec, `prune-unpushed-tombstones.spec.ts`, with one test per behaviour: an expired own tombstone above the watermark is kept and still pushed (the reproduction); no watermark keeps it; it prunes on the sweep after the watermark reaches it, with the floor raised then and not before; two `pt:` records use the lower one; another device's expired tombstone prunes regardless of the watermark
- Adjust the 9 existing tests listed above
- Docs: `docs/sync.md` line ~136 ("until the tombstone is pruned at the retention horizon"), the **Tombstone TTL** line (~167), the `retentionHorizonMs` comment (~682) and the `pt:` row of the storage table; `docs/sync-transactions.md` where it says the delete entry dies with its "expired tombstone" (~224) and the delta floor paragraph. State the keep rule once in `docs/sync.md` and link to it from the rest
- Run `yarn build`, `yarn typecheck`, and the `@quereus/sync`, `@quereus/sync-client` and `@quereus/sync-coordinator` suites
