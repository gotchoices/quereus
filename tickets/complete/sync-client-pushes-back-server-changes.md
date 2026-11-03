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
  - docs/sync-schema.md
  - docs/migration.md
  - packages/quereus-sync-client/README.md
  - packages/quereus-sync/README.md
repro: verified
----

## What changed

`SyncManager` gains `getChangesToPush(peerSiteId, sinceHLC?)`: facts and schema migrations whose `hlc.siteId` is this replica's own, plus held store-and-forward changes not written by that peer, in the same one-batch shape as `getChangesSince`. `pushLocalChanges` reads through it. `getChangesSince` keeps its filter and its callers, including `isReplicaEmpty` and `handleRequestChanges`.

The origin check runs inside the change-log scan, before the batch counter, so other devices' entries spend no budget and an empty read means nothing is left. With no watermark the read scans the change log, so it stays bounded rather than loading every `cv:` and `tb:` record.

## Validation

After the review's edits: `yarn build`, `yarn typecheck` and `yarn lint` pass, and the suites pass: `@quereus/sync` 804, `@quereus/sync-client` 106, `@quereus/sync-coordinator` 137. The other workspaces' tests were not run, since nothing outside the sync packages changed.

## Review findings

**Major, filed:** `fix/sync-offline-edit-of-pruned-row-splits-replicas` (`repro: verified`). The handoff's known gap, "a device's own older write can still return a row", had not been run. Running it showed that a fragment returns rather than a row. After B edits a row offline that A then deletes and the server prunes, A has no row, B has `(1, 'edited offline', 1)`, the server has one cell, and a newly bootstrapped device has `(1, 'edited offline', NULL)`, including when the column is `not null`. Nothing reports an error. Own-only pushes make this the usual outcome rather than an occasional one, because the row's other cells no longer travel with the edit. The fix ticket deliberately put solving this out of scope, and which state replicas should converge on needs a decision, so it was not fixed here. It is filed rather than parked as a tripwire because it is wrong now, on a reachable path.

**Minor, fixed in this pass:**

- `docs/sync-protocol.md` said a device's older write can "bring such a row back". It now states what actually happens, and names the ticket.
- `docs/sync-protocol.md` said everything a device received came through the server. A schema seed does not (`docs/sync-schema.md`). The exception is now stated.
- `docs/sync.md` § Store-and-forward relay (the GC bullet), `docs/migration.md` (two places) and the `UnknownTableDisposition` comment in `protocol.ts` still named only `getChangesSince` as the relay's read.
- Reflowed a long line in `docs/sync-protocol.md` and an awkward wrap in the `isReplicaEmpty` comment.

**Tripwire parked:** seed rows never reach the server now, so a snapshot deletes them from any table the server has rows for. Parked as a `NOTE:` in `docs/sync-schema.md` § Seeds and the server. Nothing in the repository ships a seed, so this comes from reading the code and has not been run.

**Checked, nothing found:**

- **Origin identity.** `hlc.siteId` survives every write path: apply (`change-applicator.ts`, facts and migrations), snapshot (`snapshot.ts`, `snapshot-stream.ts`) and rekey (`rekey-on-pk-change.ts`) all keep the original HLC, and only local capture stamps a new one. Site identity is persisted, and a stored one beats `config.siteId`, so a device's own facts stay its own across restarts.
- **Scan and bound.** `getAllChanges` and `getChangesSince` share the HLC-ordered key order. Filtering before the counter keeps transactions contiguous. The forwardable fold's `M ≤ C` argument still holds with a filtered scan. Every read's maximum HLC exceeds the watermark, so `pushUntilDrained` and the ack chain still make progress.
- **Change-log coverage.** Moving from `cv:`/`tb:` to the log on the no-watermark path loses nothing a device must send. Every local write and adoption writes a log entry. Snapshots do not write log entries for tombstones, but a snapshot's contents are already on the server.
- **Removed notes.** The delta-floor `NOTE:` and the `maybeBootstrap` unbounded-scan `NOTE:` are both untrue now and were rightly removed. The `isReplicaEmpty` `NOTE:` still holds, since that read is still unbounded.
- **Other readers.** `handleRequestChanges` keeps its read; nothing in the coordinator sends `request_changes`. The coordinator's own reads are unaffected. Sent state is unaffected by snapshots.
- **Handoff use cases, run with a throwaway e2e spec (since deleted).** A joining device with history pushes nothing and ends with all rows. A device holding another device's change, applied before connecting, is not bootstrapped over and pushes nothing. The other use cases are covered by the committed specs.
- **Resource and error handling.** No new resources. Breaking out of the async scan closes it, as before. Errors follow the existing push path.
- **Performance.** The full change-log walk on a quiet device already carries a `NOTE:` at the site. It is not measured, and neither did this review measure it.

**Tests:**

- **Mutation-checked**, which the handoff had not done. `changes-to-push.spec.ts` fails under each of three mutations: facts from all origins, migrations from all origins, and the origin filter moved after the batch counter. It pays for itself.
- **Kept all added tests.** The e2e is the bug's reproduction and the relay test pins a branch of the new read. Cut none.
- **Added none.** The `isReplicaEmpty` choice of read cannot be shown through the mock, which has one list and no origin filter, and a test asserting which method it calls would only restate the code. Consequence: that choice is verified by the throwaway run above and not pinned by a committed test. The `snapshot_required` double send of the same cells seen in the throwaway run is the documented "re-sent once" case.

**Considered and left as is:**

- `collectChangesSince` keeps its name though it now also scans from zero, as the handoff flagged. A rename touches about ten comments and docs for little gain.
- `collectAllChanges` still takes a peer id while its siblings take a predicate. It serves only `getChangesSince`, so the asymmetry costs nothing.
- `sync-manager-impl.ts` is 1900 lines and `sync-client.ts` 1513 (`wc -l`). This change added about 30 lines between them, so it is no reason to split either; the client's existing `NOTE:` already names its split point.

## Known gaps

- Pushes no longer partly refill a server restored from an older copy. This is intended and documented; no restore path was exercised.
- A device running a second transport alongside `SyncClient` no longer forwards other devices' changes through the server. Stated in the method's doc comment; nothing in the repository does this.
- `getChangesSince` with no watermark is still unbounded, so the `isReplicaEmpty` note about materializing every change set stands.
- The lost-acknowledgement route to the fragment defect has not been run; see the filed ticket.
