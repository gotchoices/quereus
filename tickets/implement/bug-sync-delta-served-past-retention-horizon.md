description: A device that has been offline longer than the server keeps its deletion history can reconnect, sync, and be told everything is fine while silently missing deletes. The server must refuse such a request, and the client must recover by pushing its offline work and then taking a full copy.
architecture: docs/sync-protocol.md
files:
  - packages/quereus-sync/src/sync/sync-manager-impl.ts        # canDeltaSync (~1563), pruneTombstones (~1620), getChangesSince (~1223)
  - packages/quereus-sync/src/sync/manager.ts                  # SyncManager interface — canDeltaSync signature (~70)
  - packages/quereus-sync/src/metadata/keys.ts                 # SYNC_KEY_PREFIX — add the delta-floor key
  - packages/quereus-sync/src/metadata/peer-state.ts           # model for a tiny HLC-valued record
  - packages/quereus-sync/src/sync/wire.ts                     # PROTOCOL_VERSION (~66), ServerMessage union (~701)
  - packages/quereus-sync/src/sync/protocol.ts                 # SnapshotHeaderChunk (~329), Snapshot type
  - packages/quereus-sync/src/sync/snapshot-stream.ts          # header chunk producer + applySnapshotStream header handling
  - packages/quereus-sync/src/sync/snapshot.ts                 # non-streaming getSnapshot / applySnapshot
  - packages/sync-coordinator/src/service/coordinator-service.ts # getChangesSince (~311), dead canDeltaSync wrapper (~514), restoreFromS3 (~730)
  - packages/sync-coordinator/src/server/websocket.ts          # handleGetChanges (~187)
  - packages/sync-coordinator/src/server/routes.ts             # GET /:databaseId/changes (~87)
  - packages/sync-coordinator/src/metrics/coordinator-metrics.ts
  - packages/quereus-sync-client/src/sync-client.ts            # handleMessage (~340), handleApplyResult (~565), snapshot section (~646), pushLocalChanges (~1059)
  - packages/quereus-sync/test/sync/sync-manager.spec.ts       # canDeltaSync tests (~364)
  - packages/quereus-sync-client/test/sync-client.spec.ts      # MockSyncManager (~120)
  - packages/sync-coordinator/test/websocket.spec.ts
  - packages/sync-coordinator/test/maintenance.spec.ts         # ~343 shows driving a prune with retentionHorizonMs: -1
  - docs/sync.md                                               # § change log (~405-425), maintenance (~186, ~207)
  - docs/sync-protocol.md                                      # interface (~124), flow (~321), message tables (~340-360), error codes (~445)
  - docs/sync-coordinator.md                                   # message listing (~227)
  - packages/sync-coordinator/README.md                        # Housekeeping (~76-84)
  - packages/quereus-sync/README.md                            # ~88
  - packages/quereus-sync-client/README.md                     # ~156
difficulty: hard
repro: verified
----

## The bug, reproduced

A sync server keeps a record of every deleted row (a "tombstone") so a reconnecting client can be told "this row is gone". Tombstones expire after `retentionHorizonMs` (30 days by default) and the hourly maintenance sweep now actually removes them (`pruneTombstones`). A client reconnects with `get_changes sinceHLC=<watermark>`; if a tombstone it needed has been pruned, the reply simply lacks that delete. The client applies the reply, advances its watermark, reports "synced", and keeps the row forever. Nothing on either side reports anything.

Reproduced in-process against `SyncManagerImpl` (origin peer → relay peer with `retentionHorizonMs: -1`, so every tombstone is instantly expired):

| step | `getChangesSince(client, watermark)` | `canDeltaSync(client, watermark)` |
|---|---|---|
| after insert then delete, before prune | contains the delete | `false` |
| after `pruneTombstones()` (returns 1) | zero changes, no error | `false` |

Two findings beyond the ticket's premise:

- **`canDeltaSync` is unusable as the gate in its current form.** It returns `false` for any peer with no recorded peer state, and nothing on the coordinator ever records peer state for a client (`updatePeerSyncState` has no caller in `packages/sync-coordinator/src`). Wired as-is it would refuse every client, every time.
- **Its wall-clock horizon test is the wrong axis even once that arm is dropped.** A watermark is the HLC of the *last change received*, not the time of the last sync. On a quiet database (no writes for 30 days) every client's watermark ages past the horizon while nothing was pruned, so every reconnect would force a full snapshot for no reason. In the other direction, prune compares `tombstone.createdAt` (server receipt time) while the gate compares `hlc.wallTime` (writer's clock), so a writer whose clock runs ahead can produce a tombstone that is pruned while the gate still admits a watermark below it.

## Design: a delta floor, raised by pruning, enforced by the server, recovered by the client

### 1. The delta floor (library)

Define the **delta floor**: the HLC below which this replica can no longer produce a complete incremental delta. It is exactly the greatest HLC of any tombstone this replica has pruned. An incremental request `since T` is complete iff `T >= floor` (replies carry changes strictly after `T`, so a tombstone at exactly `T` was already delivered). No clock arithmetic, no peer state, no false positives on quiet databases.

- New KV record under a new prefix (add `DELTA_FLOOR: 'df:'` to `SYNC_KEY_PREFIX`), a single key holding one serialized HLC (30 bytes, as `peer-state.ts` does). A small `metadata/delta-floor.ts` with `get(): Promise<HLC | undefined>` and `raiseBatch(batch, hlc)` that only ever moves forward.
- `pruneTombstones` tracks the max `tombstone.hlc` it deletes and raises the floor **in the same `WriteBatch`** as the tombstone deletes. A crash between deleting tombstones and raising the floor would reopen this bug, so atomicity is the point.
- `canDeltaSync(sinceHLC: HLC): Promise<boolean>` becomes `floor === undefined || compareHLC(sinceHLC, floor) >= 0`. Drop the `peerSiteId` parameter and the unknown-peer arm; update the `SyncManager` interface, its doc comment, the two existing tests (`sync-manager.spec.ts` ~364: the "unknown peer" case goes away; replace with "allows any watermark when nothing was pruned" and "refuses a watermark below a pruned delete, allows one at it"), the client spec's `MockSyncManager`, and `docs/sync-protocol.md` ~124.
- Expose `getDeltaFloor(): Promise<HLC | undefined>` on the interface (the snapshot producer and the coordinator's refusal message need the value, not just the boolean).
- `getChangesSince(peer, sinceHLC)` with `sinceHLC` below the floor: `console.warn` (do **not** throw). The throw would wedge a client whose own `pushLocalChanges` runs below its local floor (see the backlog ticket on clients pruning unpushed tombstones). The coordinator checks before calling, so on the server the warning never fires; it exists so no host can serve below the floor silently.
- `pruneQuarantine` does **not** raise the floor. Held forwardable changes are not in snapshots either, so refusing a delta there would force a snapshot that lacks them just the same. Leave a `NOTE:` at the call site saying so.

Library-level test (the reproduction, at the layer it reproduces; put it in a new `packages/quereus-sync/test/sync/delta-floor.spec.ts` modelled on the "applied (inbound) deletes" case in `changelog-orphan-cleanup.spec.ts`):

```ts
// origin: FakeTransactionSource peer; relay: no source, retentionHorizonMs: -1
insert pk 1 on origin → relay.applyChanges(inserts); watermark = last inserts[].hlc
delete pk 1 on origin → relay.applyChanges(deletes); deleteHlc = last deletes[].hlc
expect(await relay.canDeltaSync(watermark)).to.be.true      // nothing pruned yet
expect(await relay.pruneTombstones()).to.equal(1)
expect(await relay.getDeltaFloor()).to.deep.equal(deleteHlc)
expect(await relay.canDeltaSync(watermark)).to.be.false     // the delete it needs is gone
expect(await relay.canDeltaSync(deleteHlc)).to.be.true      // already had it
```

The first `true` assertion fails today (unknown peer → `false`), so the test pins both the dropped arm and the new semantics. One more case: the floor only moves forward (prune an older tombstone after a newer one; floor stays at the newer HLC).

### 2. The floor travels with snapshots (library)

A replica that applies a snapshot inherits the sender's incompleteness: tombstones the sender pruned before the snapshot are in nobody's copy. This matters on the coordinator itself: with S3 disk eviction on (`DISK_EVICTION_IDLE_MS`, 1 hour default) a store is deleted locally when idle and rebuilt from the S3 snapshot via `restoreFromS3` → `applySnapshotStream`. The `df:` key is not part of a snapshot, so without this step every eviction silently resets the floor and reopens the bug on exactly the deployments that run longest.

- Add `deltaFloor?: HLC` to `SnapshotHeaderChunk` (and its serialized form in `wire.ts`, base64 like `hlc`) and to the non-streaming `Snapshot` type. Producers fill it from `getDeltaFloor()`.
- Both apply paths set the receiver's floor to `max(own floor, header.deltaFloor)` after the metadata clear. Optional field, no `SNAPSHOT_WIRE_FORMAT_VERSION` bump: a snapshot without it (one already sitting in S3) leaves the receiver's floor as it was, which is today's behaviour and no worse.
- Do **not** instead set the receiver's floor to the snapshot's own HLC. That would be safe but would make every client whose watermark predates an hourly S3 restore take a full snapshot. Rejected for that reason.
- Test: snapshot-tombstones-and-drift.spec.ts already round-trips a snapshot between two peers; add one case where the sender has pruned (floor set) and assert the receiver's `getDeltaFloor()` equals it afterwards.

### 3. The server refuses (coordinator)

- `CoordinatorService.getChangesSince` returns a discriminated result instead of a bare array: `{ kind: 'changes'; changeSets: ChangeSet[] } | { kind: 'snapshot-required'; deltaFloor: HLC }`. It consults `canDeltaSync(sinceHLC)` when `sinceHLC` is given; a request with no `sinceHLC` is a from-nothing load and is never refused. Delete the dead `CoordinatorService.canDeltaSync` wrapper (~514).
- `websocket.ts handleGetChanges`: on `snapshot-required` send a new server message `{ type: 'snapshot_required', sinceHLC: <base64>, deltaFloor: <base64> }`. Not an `error` message: a too-old client is a normal protocol outcome, and the client's error path raises `onError` and the `error` sync event, which is wrong for it.
- `routes.ts GET /:databaseId/changes`: same decision; respond `409` with code `SNAPSHOT_REQUIRED` and the floor in the body, via the existing `errorResponse` helper.
- Add `SnapshotRequiredMessage` to the `ServerMessage` union in `wire.ts`.
- **Bump `PROTOCOL_VERSION` from 1 to 2.** A client that does not understand `snapshot_required` would log "unknown message" and sit unsynced forever, which is a breaking change in effect; the handshake version check already turns a mismatch into a loud, fatal rejection. Project rule is "backwards compat: don't worry yet", so there is no negotiation: coordinator and every client ship together, and the release notes must say so.
- Metrics: a counter `sync_delta_refused_total` next to the existing `changes*Total` counters, so an operator can see how often clients fall off the horizon (the signal for raising `SYNC_RETENTION_HORIZON_MS`).
- Coordinator test (`websocket.spec.ts`): boot with `syncConfig: { retentionHorizonMs: -1 }` as `maintenance.spec.ts` ~343 does, insert and delete a row through one client, drive one maintenance pass, then `get_changes` from a second client with the pre-delete watermark and assert `snapshot_required` with `deltaFloor` equal to the delete's HLC; the same request with no `sinceHLC` still gets `changes`.

### 4. The client recovers (sync client)

On `snapshot_required` the client must end up with the server's state **without losing work it did while offline**. Order matters because `applySnapshotStream` clears local sync metadata (`cv:`/`tb:`/`cl:`) and rewrites from the snapshot: an unpushed local delete would be undone and an unpushed local insert would become a row with no sync metadata, invisible to sync forever. That is why the automatic bootstrap today only runs on an empty replica (`isReplicaEmpty`).

New `handleSnapshotRequired` in the snapshot-bootstrap section of `sync-client.ts`:

1. Emit a `state-change` sync event explaining what is happening (the server no longer holds history back to the client's watermark; pushing local changes, then taking a full copy).
2. Unless `readOnly`: push everything since `lastSentHLC` and **await the acknowledgement**. `pushLocalChanges` already correlates each push with a `requestId` whose `apply_result` promotes the watermark (`promoteWatermark`); add a way to await that ack (a map of `requestId → resolver`, settled in `handleApplyResult`, rejected when the socket closes). Also await any acks already pending from the handshake-time push. If the push is rejected or the socket drops, stop: the reconnect path re-sends `get_changes`, gets refused again, and retries this sequence. The loop converges because pushes are idempotent.
3. `await this.runSnapshotTransfer({ type: 'get_snapshot' })`. On failure return; the existing checkpoint/resume machinery takes over on reconnect.
4. `await this.requestChangesFromServer()`: the transfer recorded the snapshot header HLC as the received watermark, which is at or above the server's floor by construction.

Local writes made *during* the transfer remain the known gap tracked by `backlog/feat-sync-bootstrap-write-gate`; this ticket does not widen it.

Client test (`sync-client.spec.ts`, `MockSyncManager` + the fake socket already there): after `handshake_ack`, deliver `snapshot_required`; assert the client sends `apply_changes` first (seed `getChangesSinceResult` with one local change set), sends `get_snapshot` only after the matching `apply_result` arrives, and sends `get_changes` with the snapshot header HLC after `snapshot_complete`. A second case with `readOnly: true` skips the push.

### Known limit of the recovery (not fixed here)

A snapshot apply upserts the snapshot's rows but never deletes a local row that is absent from the snapshot. The ghost rows a too-old client is holding are therefore **still there after the recovery** (they just stop diverging further). That is a defect in snapshot apply itself, with its own site, filed separately as `fix/bug-sync-snapshot-apply-keeps-rows-absent-from-snapshot`. This ticket is still worth landing first: it ends the silent part (nothing is ever reported as synced while incomplete) and the full-copy path is where the ghost fix will plug in.

### Rejected alternatives

- **Wall-clock horizon gate** (`now - sinceHLC.wallTime > retentionHorizonMs`, what `canDeltaSync` does today): over-refuses on quiet databases and under-refuses under writer clock skew, as described above.
- **Peer-watermark pruning** (only prune tombstones below the minimum known client watermark): lossless, but a client that never returns pins retention forever, and the coordinator records no client watermarks today. The floor keeps time-based pruning and makes it honest instead.
- **Throwing from `getChangesSince` below the floor**: wedges the client push path; warn instead.
- **Reusing the `error` message with a new code**: semantically wrong (see § 3) and routes through `onError`.

## Docs

- `docs/sync.md` § change log (~405-425): replace the "deliberately unwired … not yet called by the coordinator" paragraph with the delta-floor definition and the invariant that every prune of deliverable history raises it. Mention it in § maintenance where `pruneTombstones` is listed.
- `docs/sync-protocol.md`: `canDeltaSync` signature (~124), flow step 2 (~321), the message tables (~340-360: add `snapshot_required`), and the client bootstrap section (~470-495: add the refusal trigger and the push-first rule). Note the protocol version bump.
- `docs/sync-coordinator.md` ~227 message listing; `packages/sync-coordinator/README.md` Housekeeping: delete the "does not yet refuse" interim guidance, replace with one line on `sync_delta_refused_total`; `packages/quereus-sync/README.md` ~88 and `packages/quereus-sync-client/README.md` ~156.
- Release notes: wire protocol v2, coordinator and clients must be upgraded together.

## TODO

Phase 1, library
- Add the `df:` prefix and `metadata/delta-floor.ts` (get, forward-only raise into a batch)
- `pruneTombstones` raises the floor in its own batch; `pruneQuarantine` gets the `NOTE:` explaining why it does not
- `canDeltaSync(sinceHLC)` compares against the floor; drop the peer arm; add `getDeltaFloor()` to the interface; `getChangesSince` warns below the floor
- Update `SyncManager` interface docs, `MockSyncManager`, and the two `sync-manager.spec.ts` cases; add `delta-floor.spec.ts` with the reproduction above plus the forward-only case

Phase 2, snapshots carry the floor
- `deltaFloor?` on `SnapshotHeaderChunk`, its wire form, and `Snapshot`; producers fill it; both apply paths take `max`
- One round-trip test in `snapshot-tombstones-and-drift.spec.ts`

Phase 3, coordinator
- `getChangesSince` returns the discriminated result; remove the dead wrapper; websocket sends `snapshot_required`; HTTP route answers 409 `SNAPSHOT_REQUIRED`
- `SnapshotRequiredMessage` in `wire.ts`; `PROTOCOL_VERSION = 2`
- `sync_delta_refused_total` counter
- `websocket.spec.ts` case described in § 3

Phase 4, client
- `handleSnapshotRequired`: push and await ack, snapshot, catch-up; ack-awaiting hook on `handleApplyResult`, rejected on socket close
- Two `sync-client.spec.ts` cases described in § 4

Phase 5
- Docs and README updates listed above; release-note line for protocol v2
- `yarn build && yarn test` across `quereus-sync`, `quereus-sync-client`, `sync-coordinator`; `yarn typecheck`
