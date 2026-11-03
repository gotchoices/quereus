description: A device that has been offline longer than the server keeps its deletion history can reconnect, sync, and be told everything is fine while silently missing deletes. The server now refuses such a request, and the client recovers by pushing its offline work and then taking a full copy.
architecture: docs/sync-protocol.md
files:
  - packages/quereus-sync/src/metadata/delta-floor.ts            # DeltaFloorStore (df: key) — get / admits / raiseBatch
  - packages/quereus-sync/src/metadata/keys.ts                   # DELTA_FLOOR prefix
  - packages/quereus-sync/src/sync/sync-manager-impl.ts          # canDeltaSync(sinceHLC), getDeltaFloor, pruneTombstones raises floor in-batch, getChangesSince warns below floor
  - packages/quereus-sync/src/sync/manager.ts                    # interface: canDeltaSync(sinceHLC), getDeltaFloor()
  - packages/quereus-sync/src/sync/sync-context.ts               # deltaFloor on SyncContext
  - packages/quereus-sync/src/sync/protocol.ts                   # deltaFloor? on Snapshot + SnapshotHeaderChunk
  - packages/quereus-sync/src/sync/wire.ts                       # PROTOCOL_VERSION = 2, SnapshotRequiredMessage, header codec carries deltaFloor
  - packages/quereus-sync/src/sync/snapshot-stream.ts            # producer fills header; clearExistingMetadata inherits the floor in the clear batch
  - packages/quereus-sync/src/sync/snapshot.ts                   # same for the non-streaming path
  - packages/sync-coordinator/src/service/coordinator-service.ts # getChangesSince → GetChangesOutcome
  - packages/sync-coordinator/src/server/websocket.ts            # snapshot_required reply
  - packages/sync-coordinator/src/server/routes.ts               # 409 SNAPSHOT_REQUIRED with error.deltaFloor
  - packages/sync-coordinator/src/metrics/coordinator-metrics.ts # sync_delta_refused_total
  - packages/quereus-sync-client/src/sync-client.ts              # handleSnapshotRequired, ack waiters, pushLocalChanges returns requestId
  - packages/quereus-sync/test/sync/delta-floor.spec.ts
  - packages/quereus-sync/test/sync/snapshot-tombstones-and-drift.spec.ts
  - packages/quereus-sync-client/test/sync-client.spec.ts
  - packages/sync-coordinator/test/websocket.spec.ts
  - docs/sync.md
  - docs/sync-protocol.md
  - docs/sync-coordinator.md
  - packages/sync-coordinator/README.md
repro: verified
----

# Delta sync refused past the retention horizon

Landed in `ticket(implement): bug-sync-delta-served-past-retention-horizon`, reviewed here.

## What landed

**The delta floor.** A replica records the greatest HLC of any tombstone it has pruned under a single `df:` record (`metadata/delta-floor.ts`). `pruneTombstones` raises it in the same `WriteBatch` as the tombstone deletes; it only moves forward. `canDeltaSync(sinceHLC)` is `floor === undefined || sinceHLC >= floor`; the old peer-state arm (which refused every client, since the coordinator never records client peer state) and the wall-clock arm (wrong axis) are gone. `getChangesSince` below the floor warns and still answers; `pruneQuarantine` deliberately does not raise the floor.

**The floor travels with snapshots.** Optional `deltaFloor` on `SnapshotHeaderChunk` / `Snapshot`, base64 on the wire. Both producers fill it; both apply paths raise the receiver's floor to `max(own, header)` in the same batch as the metadata clear (review change, see below). A header without the field leaves the floor alone, so snapshots already in S3 restore cleanly.

**The server refuses.** `CoordinatorService.getChangesSince` returns a discriminated `GetChangesOutcome`; a request with no watermark is never refused. WebSocket answers `snapshot_required { sinceHLC, deltaFloor }`; HTTP answers `409 SNAPSHOT_REQUIRED` with `error.deltaFloor`. `sync_delta_refused_total` counts refusals. `PROTOCOL_VERSION` is 2 (flag day; release note in the gitignored `.release-notes.pending.md`).

**The client recovers.** On `snapshot_required`, unless read-only, the client waits for any push in flight, pushes everything since its sent watermark, waits for that push's `apply_result`, then runs a `get_snapshot` transfer and sends `get_changes` from the snapshot's HLC. Ack waiting is a `requestId → resolvers` map settled from `handleApplyResult` once the id leaves the pending set (an ack that subsumes the id also releases it), rejected on socket close, `disconnect()`, a fatal error, or `APPLY_CHANGES_ERROR`.

## Review findings

**Read first, before the handoff:** the full implement diff (library, coordinator, client, tests, docs), then `clearExistingMetadata`, the streaming header/resume path, `promoteWatermark`, the client's unserialized message dispatcher, the S3 snapshot store's codec usage, the change-log key axis, and the HLC clock's receive semantics.

**Checked and confirmed sound (no change):**
- The floor and the watermark are on the same axis: the change log is keyed by origin HLC, tombstones carry the delete's origin HLC, and `collectChangesSince` returns strictly `> sinceHLC`, so `T >= floor` is the right admit test. A straggler delete with an older HLC arriving after a prune cannot lower the floor and would have been missed by HLC-keyed delta anyway (pre-existing property, not widened).
- `handleSnapshotRequired` awaits an `apply_result` from inside a message handler; safe because `ws.onmessage` invokes `handleMessage` without serialization, so acks and snapshot chunks still flow.
- Snapshot-loop risk (floor above the snapshot's HLC) does not arise: the sender's HLC clock advanced past every tombstone it applied, so its snapshot HLC is at or above its floor. Only a degenerate horizon (`-1`, as in tests) can refuse the post-snapshot `get_changes`.
- The metadata clear wipes `cv:`/`tb:`/`cl:` only, so the receiver's own `df:`, `ps:` and `pt:` records survive and `max(own, sender's)` is genuinely a max. The resumed-stream path re-runs the header case and so re-inherits.
- The S3 restore path serializes and deserializes via `serializeSnapshotChunk`, so the floor rides along and a coordinator rebuilt after disk eviction keeps it. No HTTP-based client exists to update for the 409.
- Coordinator `canDeltaSync` then `getDeltaFloor()!` is not racy: between the two calls the floor can only rise, never become undefined.

**Fixed inline (minor):**
- **Floor inheritance was a separate write after the clear batch.** A crash between the two leaves a replica with no tombstones and a floor that says it can serve anything — the exact gap the prune path was careful to close. Both apply paths now call `raiseBatch` on the clear batch itself (`clearExistingMetadata` takes the sender's floor); the standalone `DeltaFloorStore.raise()` is deleted so there is no non-batch variant to reach for.
- **Handshake order.** `seedSentWatermark()` ran after the `get_changes` went out, so a fast `snapshot_required` could run the recovery's push from an unseeded (null) sent watermark and replay the whole local history. Seed now precedes the request.
- **Docs gaps:** `df:` added to the key-prefix table in `docs/sync.md`; `sync_delta_refused_total` added to the coordinator README's metrics list; the "after its metadata clear" wording updated to "in the same batch as". An inaccurate comment in `handleSnapshotRequired` (claimed an explicit `requestSnapshot()` does its own catch-up; it does not) corrected. `requestSnapshot()`'s contract now says unpushed prior work meets the same fate as a concurrent write and that this explicit path does not push first.

**Tests:** kept all seven implementer tests (each pins one behaviour; the first `delta-floor.spec.ts` case is the reproduction and fails on the old peer-state arm). Added one: the non-streaming `getSnapshot` / `applySnapshot` carries and inherits the floor — the handoff named it unverified, and the review change touched that path. No test cut.

**Tripwires parked as `NOTE:` at the site:**
- `sync-manager-impl.ts` `getChangesSince`: a client that inherited the server's floor via a recovery and has pushed nothing since logs the below-floor warning on every reconnect's handshake push until it next writes. False positive for outbound pushes; if the noise matters, let the push path pass a flag that skips the check. Left in place because `backlog/bug-sync-client-prunes-unpushed-tombstones` relies on the same warning for the true-positive case.
- `sync-client.ts` `handleSnapshotRequired`: only a reconnect retries the recovery. A push answered with `APPLY_CHANGES_ERROR` leaves the socket open, so the recovery stays parked (broadcasts still land; the gap does not) until the socket next drops. If that shows up, re-send `get_changes` after the reconnect backoff.
- Pre-existing `NOTE:` on the stale-pending-id wait after an auto-reconnect stands as written.

**Tickets filed:** none. The ghost-row limit (snapshot apply never deletes rows absent from the snapshot) is already `fix/bug-sync-snapshot-apply-keeps-rows-absent-from-snapshot`; the client-side prune of unpushed deletes is already `backlog/bug-sync-client-prunes-unpushed-tombstones`. Nothing else in this diff met the filing bar: the HTTP 409 branch is two-line glue over the same service decision the WebSocket test covers; a per-tenant label on the refusal counter was not asked for; the duplicate push on a racing handshake is idempotent and acked separately.

**Validation:** `yarn build` clean; `yarn typecheck` clean; `yarn lint` clean; `@quereus/sync` 773 passing, `@quereus/sync-client` 87 passing, `@quereus/sync-coordinator` 135 passing.
