description: Devices send the server's own data back to it, not just their own edits. This wastes a full upload whenever a device joins, and it can bring back rows that were deleted on the server, leaving devices permanently disagreeing. Devices should upload only what they wrote themselves.
architecture: docs/sync-protocol.md#sync-flow-master-to-many-masters
files:
  - packages/quereus-sync/src/sync/sync-manager-impl.ts # getChangesSince, collectChangesSince, collectAllChanges, collectForwardableChanges, collectSchemaMigrations
  - packages/quereus-sync/src/sync/manager.ts # SyncManager interface, gains the new read
  - packages/quereus-sync/src/metadata/change-log.ts # getChangesSince, getAllChanges: the HLC-ordered scans the new read uses
  - packages/quereus-sync-client/src/sync-client.ts # pushLocalChanges switches to the new read; handleRequestChanges and isReplicaEmpty do not
  - packages/quereus-sync-client/test/sync-client.spec.ts # MockSyncManager serves pushes from getChangesSince today
  - packages/quereus-sync/test/sync/store-and-forward-relay.spec.ts # where the new read's relay arm can be pinned
  - packages/sync-coordinator/test/sync-coordinator-roundtrip.e2e.spec.ts # home for the reproduction
  - packages/sync-coordinator/test/_e2e-harness.ts
  - docs/sync-protocol.md
  - docs/sync.md
  - packages/quereus-sync-client/README.md
repro: verified
----

## Cause

`pushLocalChanges` (`sync-client.ts`) reads `getChangesSince(serverSiteId, lastSentHLC)`. That read leaves out only changes written by the given site. A coordinator writes nothing itself, so the filter removes nothing, and every change the device received counts as unsent until its sent watermark passes it. `getChangesSince` is right for its other job, a server answering a device, where sending other devices' changes is the point. The defect is that the device's push asks the same question.

## Reproduction results

A throwaway end-to-end spec ran real clients against a real coordinator, wrapping `service.applyChanges` to record pushes. It ran on the current code, then with a proxy around the manager that dropped every change set not written by this device from `getChangesSince`, which approximates the fix below.

| Scenario | Current code | With own-writes filter |
|---|---|---|
| New device joins a database holding 7 transactions (`batchSize` 1000) | one push of 7 change sets, `applied: 0` | no pushes, device holds 7 rows |
| B holds rows 1 and 2 from broadcasts, disconnects; A deletes row 1; server prunes the tombstone; B reconnects | two pushes, each `applied: 3`. A has row 2; B has rows 1, 2; server has rows 1, 2 | no pushes. A, B and server all have only row 2 |
| Same, and B also inserted row 3 and edited row 2 offline | B has rows 1, 2, 3; A has rows 2, 3; server has rows 1, 2, 3 | A, B and server all have rows 2 and 3, including B's edit |

The proxy filters after the bounded read, so it does not exercise the batch-bound requirement below, and it also narrowed the read `isReplicaEmpty` makes. The real fix differs on both points.

## Design

Add a separate read to `SyncManager` and leave `getChangesSince` as it is.

```typescript
/**
 * What this replica should push upstream to `peerSiteId`: facts and schema migrations this
 * replica wrote, plus held store-and-forward changes not written by that peer, all after
 * `sinceHLC`. Same shape and transaction-grained bound as getChangesSince. Omitting sinceHLC
 * starts from the beginning of the change log; the result is still one bounded batch.
 */
getChangesToPush(peerSiteId: SiteId, sinceHLC?: HLC): Promise<ChangeSet[]>;
```

A separate read is preferred over an option on `getChangesSince` because the two differ in more than the filter: the delta-floor warning concerns inbound completeness and is a false positive on a push (the `NOTE:` in `getChangesSince` says so, and goes away), and the push read can be bounded from zero where the serving read cannot.

"Written by this replica" means `hlc.siteId` equals `getSiteId()`. Every change carries its origin there, and it survives relays, applies and snapshots: `change-applicator.ts` stores the incoming HLC unchanged and `snapshot-stream.ts` writes each cell and migration with its original HLC. Only local capture and `adoptUnrecordedRows` produce this site's HLCs.

The site id check happens inside the change-log scan, before the batch counter, exactly where the peer filter sits today in `collectChangesSince`. A run of other devices' entries therefore consumes no batch budget and can never produce an empty result while own work remains, so "nothing left" stays trustworthy for the recovery snapshot. It also lets the sent watermark stop at the last own change. `pushUntilDrained` and the acknowledgement chain both rely on each read's maximum HLC exceeding the watermark, and that still holds.

With no watermark, scan the change log (`changeLog.getAllChanges`) rather than reusing `collectAllChanges`. The change log is ordered by HLC, so the same early exit applies. This matters more after the fix: a device that never writes never gets an acknowledgement, so it has no sent watermark and would otherwise read and deserialize every `cv:` and `tb:` record on every handshake. It also resolves the `NOTE:` above the adoption call in `maybeBootstrap`, which can then go. Entries for dropped tables already resolve to nothing in `resolveLogEntry`.

Suggested shape: factor the body of `collectChangesSince` into a helper taking the log entries and an origin predicate, give `collectSchemaMigrations` the same predicate, and share the final `buildTransactionChangeSets` call and its oversized warning between the two public reads.

## Constraints and how each is met

**Store-and-forward relay.** `getChangesToPush` still folds in `collectForwardableChanges(peerSiteId, sinceHLC)`, so a device holding another device's change for a retired table still offers it. Direct peer-to-peer relay goes through `getChangesSince`, which does not change, so `store-and-forward-relay*.spec.ts` should pass untouched.

The cost is that nothing records which peer a held change came from, so a device that received one from the server pushes it back once, until the sent watermark passes it. This takes a device that has retired a table the server still has, using the non-default `store-and-forward` disposition. Leave a `NOTE:` at the fold: conditional on that window, and if it matters, record the source peer on the quarantine entry.

**Third-party changes learned over another route.** An application running its own second transport alongside `SyncClient` would no longer forward other devices' changes through the server. The client already assumes one coordinator per database (the `NOTE:` in `maybeBootstrap`), and nothing in the repository does this. State the assumption in the new method's doc comment.

**Server data loss.** Re-upload could only refill a server restored from an older copy (the coordinator's S3 restore is the real path) with changes received since that device last pushed, because everything below the sent watermark is never re-sent. No document or test relies on it, and a device's acknowledged own writes were never covered either. This fix removes a partial accident, not a feature; say so in `docs/sync-protocol.md`.

**`isReplicaEmpty` keeps `getChangesSince`.** Any fact on the device, from anyone, blocks a wholesale bootstrap. Narrowing it would let a device holding changes from another route be bootstrapped over them. Its comment says "of our own", which is inaccurate; reword it.

**`handleRequestChanges` keeps `getChangesSince`.** It answers a named peer, and nothing in the coordinator sends `request_changes`.

## Not addressed

From reading the code, not run: a device's own older fact can still return a row whose tombstone the server has pruned. That is B editing row 1 offline, or an own push whose acknowledgement was lost and is re-sent. Offline work has to go out, and the server cannot tell this from a legitimate write once the tombstone is gone. `docs/sync.md` already limits delete-wins to "until the tombstone is pruned at the retention horizon". Do not attempt to solve it here; add one sentence to the snapshot recovery section of `docs/sync-protocol.md` in place of the exception being removed.

## Tripwire to park

The read walks every change-log key past the sent watermark, and a device's watermark no longer moves when it only receives. A quiet device walks the whole log on each handshake, keys only with no record reads, and a device that writes rarely re-walks what it has received since its last write. Add a `NOTE:` at the scan: if this shows up, persist a "scanned through" position per peer. This was not measured.

## Tests

The first is the bug's reproduction.

- `sync-coordinator-roundtrip.e2e.spec.ts`: A and B connected; A inserts rows 1 and 2, B receives them by broadcast; B disconnects and inserts row 3 and edits row 2 offline; A deletes row 1; prune on the server; B reconnects. Poll with `waitFor`, then assert that row 1 is absent on A, B and the server, and that B's insert and edit are present on all three. Wrap `service.applyChanges` and assert that no push carried a change set from A. To prune, get the store entry through the service's private `getStore`, set `syncManager.config.retentionHorizonMs = -1`, and call `pruneTombstones()`. To read the server's rows, take `getSnapshot()` and collect the primary keys in `tables[].columnVersions`.
- A manager-level spec in `packages/quereus-sync/test/sync/`, with `batchSize: 1`: a replica holding a run of other devices' transactions before and after its own returns only its own, one batch at a time, never empty until they are exhausted, from both a watermark and no watermark. Include a forwardable held change being offered, in the relay spec or here.

`sync-client.spec.ts` needs `MockSyncManager` to serve pushes from the new read, and the delta-push assertion near `getChangesSinceCalls` updated. Keep the mock's existing behaviour for `handleRequestChanges` and `isReplicaEmpty`. Do not add a client-level test for the filter: the mock cannot show it.

## TODO

- Add `getChangesToPush` to `SyncManager` and `SyncManagerImpl`, with the scan filter, bounded no-watermark path, own-origin migrations and forwardable fold described above
- Switch `pushLocalChanges` to it and correct its comment, which says the filter removes "changes that originated from the server"
- Remove the now-untrue notes: the delta-floor false-positive `NOTE:` and its wording in `getChangesSince`, and the unbounded-scan `NOTE:` in `maybeBootstrap`; reword the `isReplicaEmpty` comment
- Add the `NOTE:`s for the forwardable echo and the change-log walk
- Add the end-to-end reproduction and the manager-level spec; update `MockSyncManager` and its call-tracking assertions
- Update docs: `docs/sync-protocol.md` (Sync API block, push loop in Delta Sync Optimization, remove the "Known exception" naming this ticket in Client snapshot bootstrap, add the own-fact limit and the server-restore note), the transport example in `docs/sync.md` step 7 which reads `getChangesSince(serverSiteId, ...)` as local changes, the relay note in `docs/sync.md` § Store-and-forward relay, and any matching line in `packages/quereus-sync-client/README.md`
- Run `yarn build`, then the tests for `@quereus/sync`, `@quereus/sync-client` and `@quereus/sync-coordinator`, plus `yarn typecheck`. Coordinator tests resolve workspace packages through their built `dist`, so build first
