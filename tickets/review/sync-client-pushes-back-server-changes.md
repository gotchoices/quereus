description: Devices now upload only what they wrote themselves, instead of sending the server's own data back to it. That removes the wasted upload when a device joins and stops a returning device from bringing back rows that were deleted on the server.
architecture: docs/sync-protocol.md#sync-flow-master-to-many-masters
files:
  - packages/quereus-sync/src/sync/sync-manager-impl.ts # getChangesToPush, buildChangeSetsForPeer; collectChangesSince and collectSchemaMigrations now take an origin predicate
  - packages/quereus-sync/src/sync/manager.ts # SyncManager.getChangesToPush
  - packages/quereus-sync-client/src/sync-client.ts # pushLocalChanges switched; isReplicaEmpty and handleRequestChanges deliberately keep getChangesSince
  - packages/quereus-sync-client/test/sync-client.spec.ts # MockSyncManager
  - packages/quereus-sync/test/sync/changes-to-push.spec.ts # new
  - packages/quereus-sync/test/sync/store-and-forward-relay.spec.ts
  - packages/sync-coordinator/test/sync-coordinator-roundtrip.e2e.spec.ts # the reproduction
  - docs/sync-protocol.md
  - docs/sync.md
  - packages/quereus-sync-client/README.md
  - packages/quereus-sync/README.md
repro: verified
----

## What changed

`SyncManager` gains `getChangesToPush(peerSiteId, sinceHLC?)`: facts and schema migrations whose `hlc.siteId` is this replica's own, plus held store-and-forward changes not written by that peer, in the same one-batch shape as `getChangesSince`. `pushLocalChanges` reads through it. `getChangesSince` keeps its filter and its callers, including `isReplicaEmpty` and `handleRequestChanges`.

The origin check runs inside the change-log scan, before the batch counter, so other devices' entries spend no budget and an empty read means nothing is left. With no watermark the read scans the change log, so it stays bounded rather than loading every `cv:` and `tb:` record.

Notes removed as now untrue: the delta-floor false positive in `getChangesSince`, and the unbounded-scan note in `maybeBootstrap`. Notes added at `getChangesToPush`: the one-time echo of a held change, and the full change-log walk on a quiet device (not measured).

## Use cases to check

- A new device joining a database with history sends no `apply_changes`.
- A device that received rows by broadcast, went offline, wrote its own rows, and returned after a server prune: its writes reach everyone, the deleted row stays deleted on every replica, and nothing another device wrote is pushed.
- A device with a long run of received changes before its own unsent write still pushes that write, on a small `batchSize`.
- A device that retired a table under `store-and-forward` still offers its held changes upstream, but never to their origin.
- A device holding changes learned over another route still counts as non-empty and is not bootstrapped over.

## Validation

`yarn build`, `yarn typecheck` and the suites pass: `@quereus/sync` 804, `@quereus/sync-client` 106, `@quereus/sync-coordinator` 137.

The reproduction was checked against the old behaviour by patching the built client back to `getChangesSince` (dist only, since restored): it fails with `waitFor timed out ... A, B and the server to hold rows 2 and 3 only`. The manager spec was not mutation-checked.

## Tests added

- `sync-coordinator-roundtrip.e2e.spec.ts`, "a device returning past a pruned delete...": the bug's reproduction, real clients against a real coordinator. Convergence of A, B and the server, including B's offline edit, and every change set B pushes being B's own.
- `changes-to-push.spec.ts`, "drains only its own work...": other devices' transactions and a migration before, between and after its own, from no watermark and from a watermark; one transaction per read, never empty until exhausted, only its own migration.
- `store-and-forward-relay.spec.ts`, "getChangesToPush offers a held forwardable change, except to its origin": the relay arm of the new read.

`MockSyncManager` serves both reads from one list, and its delta-push assertions read `getChangesToPushCalls`. No client-level filter test, because the mock cannot show it.

## Departures from the ticket, and things to look at

- The manager spec uses `batchSize` 2, not 1. An own insert writes two columns, so 1 would log an oversized-transaction warning per read; 2 still gives one transaction per read.
- The e2e reaches the store through the public `service.storeManager` rather than the private `getStore`. It still casts to set `config.retentionHorizonMs`, since nothing public changes it after startup.
- `collectChangesSince` keeps its name though it now also scans from zero. Comments, docs and tests in about ten places refer to it by name.
- The mock's `getChangesSinceResult` field is renamed `changeSets`, which accounts for most of that spec's diff.
- `isReplicaEmpty`'s doc comment changed beyond "of our own": the sentence on the second condition alone described a device whose contents came from the server, which no longer matched what that condition tests.

## Known gaps

- Not addressed, per the ticket: a device's own older write can still return a row whose tombstone the server pruned (an offline edit of that row, or a re-sent push whose acknowledgement was lost). Stated in `docs/sync-protocol.md`; not run.
- Pushes no longer partly refill a server restored from an older copy. This is intended and documented; no restore path was exercised.
- A device running a second transport alongside `SyncClient` no longer forwards other devices' changes through the server. Stated in the method's doc comment; nothing in the repository does this.
- `getChangesSince` with no watermark is still unbounded, so the `isReplicaEmpty` note about materializing every change set stands.
