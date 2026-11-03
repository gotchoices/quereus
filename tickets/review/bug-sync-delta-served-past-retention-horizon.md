description: A device that has been offline longer than the server keeps its deletion history can reconnect, sync, and be told everything is fine while silently missing deletes. The server now refuses such a request, and the client recovers by pushing its offline work and then taking a full copy.
architecture: docs/sync-protocol.md
files:
  - packages/quereus-sync/src/metadata/delta-floor.ts            # NEW: DeltaFloorStore (df: key) — get / admits / raiseBatch / raise
  - packages/quereus-sync/src/metadata/keys.ts                   # DELTA_FLOOR prefix
  - packages/quereus-sync/src/sync/sync-manager-impl.ts          # canDeltaSync(sinceHLC), getDeltaFloor, pruneTombstones raises floor in-batch, getChangesSince warns below floor, pruneQuarantine NOTE
  - packages/quereus-sync/src/sync/manager.ts                    # interface: canDeltaSync(sinceHLC), getDeltaFloor()
  - packages/quereus-sync/src/sync/sync-context.ts               # deltaFloor on SyncContext
  - packages/quereus-sync/src/sync/protocol.ts                   # deltaFloor? on Snapshot + SnapshotHeaderChunk
  - packages/quereus-sync/src/sync/wire.ts                       # PROTOCOL_VERSION = 2, SnapshotRequiredMessage, header codec carries deltaFloor
  - packages/quereus-sync/src/sync/snapshot-stream.ts            # producer fills header; apply inherits max(own, header) after the clear
  - packages/quereus-sync/src/sync/snapshot.ts                   # same for the non-streaming path
  - packages/quereus-sync/src/metadata/change-log.ts             # pruneEntriesBefore doc comment updated
  - packages/sync-coordinator/src/service/coordinator-service.ts # getChangesSince → GetChangesOutcome; dead canDeltaSync wrapper deleted
  - packages/sync-coordinator/src/server/websocket.ts            # snapshot_required reply
  - packages/sync-coordinator/src/server/routes.ts               # 409 SNAPSHOT_REQUIRED with error.deltaFloor
  - packages/sync-coordinator/src/metrics/coordinator-metrics.ts # sync_delta_refused_total
  - packages/quereus-sync-client/src/sync-client.ts              # handleSnapshotRequired, ack waiters, pushLocalChanges returns requestId
  - packages/quereus-sync/test/sync/delta-floor.spec.ts          # NEW
  - packages/quereus-sync/test/sync/snapshot-tombstones-and-drift.spec.ts
  - packages/quereus-sync/test/sync/sync-manager.spec.ts
  - packages/quereus-sync/test/sync/sync-protocol-e2e.spec.ts
  - packages/quereus-sync-client/test/sync-client.spec.ts
  - packages/sync-coordinator/test/websocket.spec.ts
  - packages/sync-coordinator/test/service.spec.ts
  - docs/sync.md
  - docs/sync-protocol.md
  - docs/sync-coordinator.md
  - packages/sync-coordinator/README.md
  - packages/quereus-sync/README.md
  - packages/quereus-sync-client/README.md
difficulty: hard
repro: verified
----

## What landed

**The delta floor (library).** A replica now records the greatest HLC of any tombstone it has pruned under a new single-key `df:` record (`metadata/delta-floor.ts`). `pruneTombstones` raises it in the *same* `WriteBatch` as the tombstone deletes, and it only moves forward. `canDeltaSync(sinceHLC)` is now just `floor === undefined || sinceHLC >= floor`: the peer-state arm (which refused every client, since the coordinator never records client peer state) and the wall-clock arm (wrong axis: a quiet database would age every watermark out) are both gone. `getDeltaFloor()` is new on the interface. `getChangesSince` below the floor logs a `console.warn` and still answers (a throw would wedge a client's own push path). `pruneQuarantine` deliberately does not raise the floor (NOTE at the site: held forwardable changes are not in snapshots either, so a forced snapshot would lack them just the same).

**The floor travels with snapshots.** `deltaFloor?` is an optional field on `SnapshotHeaderChunk` and `Snapshot`, base64 on the wire like `hlc`. Both producers fill it (read live, even on a resumed stream); both apply paths raise the receiver's floor to `max(own, header)` right after the metadata clear. A snapshot without the field (one already in S3) leaves the receiver's floor alone. No `SNAPSHOT_WIRE_FORMAT_VERSION` bump. This matters for the coordinator's S3 restore after disk eviction, which would otherwise silently reset the floor.

**The server refuses.** `CoordinatorService.getChangesSince` returns `{ kind: 'changes', changeSets } | { kind: 'snapshot-required', deltaFloor }`. It checks `canDeltaSync` only when `sinceHLC` is present (a from-nothing load is never refused). WebSocket sends a new `snapshot_required { sinceHLC, deltaFloor }` message, not an `error`. HTTP answers `409` with code `SNAPSHOT_REQUIRED` and `error.deltaFloor` in the body (the reply is inlined rather than routed through `errorResponse`, which cannot carry the extra field). `sync_delta_refused_total` counts refusals. The dead `CoordinatorService.canDeltaSync` wrapper is deleted. **`PROTOCOL_VERSION` is 2**: a v1 client would log the new reply as unknown and sit unsynced forever.

**The client recovers.** On `snapshot_required`, `SyncClient.handleSnapshotRequired` (1) emits a `state-change` event, (2) unless `readOnly`, waits for any push already in flight, pushes everything since `lastSentHLC`, and waits for that push's `apply_result`, (3) runs a `get_snapshot` transfer through the existing `runSnapshotTransfer`, (4) sends `get_changes` from the snapshot's HLC. Ack waiting is a `requestId → resolvers` map settled from `handleApplyResult` once the id leaves `pendingSentHLCs` (so an ack that *subsumes* the id also releases it), rejected on socket close, `disconnect()`, a fatal error, or `APPLY_CHANGES_ERROR` (a failed push never gets an `apply_result`). On any rejection the sequence stops; the reconnect re-sends `get_changes`, is refused again, and retries. `pushLocalChanges` now returns the request id it sent (or null).

**Docs.** `docs/sync.md` (maintenance bullet + a new *The delta floor* paragraph under § Read side, replacing the "deliberately unwired … not yet called" text), `docs/sync-protocol.md` (interface, flow step 2, message table, protocol-version history, delta-sync step 4, client bootstrap's third trigger with the push-first rule and the ghost-row limit), `docs/sync-coordinator.md` (HTTP 409 row, WS message union), the three READMEs, and `.release-notes.pending.md` at the repo root (gitignored by design, see `docs/releasing.md`) saying wire protocol v2 requires coordinator and clients to upgrade together.

## Tests added (one per behaviour)

| test | verifies |
|---|---|
| `delta-floor.spec.ts` › refuses a watermark below a pruned delete, admits one at it, and admits anything before any prune | The reproduction: origin → relay with `retentionHorizonMs: -1`; before prune any watermark is admitted (fails on the old peer-state arm), after prune the floor equals the delete's HLC, the pre-delete watermark is refused, the delete's own HLC is admitted |
| `delta-floor.spec.ts` › only ever moves forward | Pruning an older tombstone after a newer one leaves the floor at the newer HLC |
| `snapshot-tombstones-and-drift.spec.ts` › snapshot carries the delta floor | Streaming header carries the sender's floor; a receiver with none ends with exactly it after `applySnapshotStream` |
| `sync-manager.spec.ts` › canDeltaSync › allows any watermark when nothing was pruned | The no-prune baseline (replaces the two peer-state cases) |
| `websocket.spec.ts` › Get Changes below the delta floor | Real coordinator with `sync.retentionHorizonMs: -1`: insert + delete through one client, one `runCoordinatorMaintenancePass`, then a second client gets `snapshot_required` with `deltaFloor` = the delete's HLC for the pre-delete watermark, `changes` at the floor itself, and `changes` for a from-nothing request |
| `sync-client.spec.ts` › on snapshot_required: pushes unsent local work, takes the snapshot only after the ack, then catches up | `apply_changes` goes out, `get_snapshot` is held until the matching `apply_result`, sent watermark persisted, final `get_changes` carries the snapshot header HLC |
| `sync-client.spec.ts` › on snapshot_required in readOnly mode | No `apply_changes`; `get_snapshot` at once |

Also updated: `sync-protocol-e2e.spec.ts` "should correctly track peer sync state" now asserts `getPeerSyncState` directly instead of going through `canDeltaSync` (which no longer looks at peer state); `service.spec.ts` for the discriminated result; `MockSyncManager` for the new signatures.

## Validation run

- `yarn workspace @quereus/sync test` 772 passing; `@quereus/sync-client` 87 passing; `@quereus/sync-coordinator` 135 passing.
- `yarn build` and `yarn typecheck` across the repo: clean.
- `yarn lint` not run: only `packages/quereus` has a real lint and nothing there changed.

## Known gaps and things worth a second look

- **Ghost rows survive the recovery.** Snapshot apply upserts but never deletes a local row absent from the snapshot, so the rows a too-old client is holding stay after the full copy (they just stop diverging). Tracked separately as `fix/bug-sync-snapshot-apply-keeps-rows-absent-from-snapshot`; this ticket ends the *silent* part only.
- **Non-streaming `applySnapshot` floor inheritance is untested.** Same mechanism as the streaming path, same three lines, but only the streaming round-trip has a test. A reviewer who wants parity can add one case to the `non-streaming snapshot carries tombstones` suite using `getSnapshot` / `applySnapshot`.
- **Pending-ack wait after an auto-reconnect.** `pendingSentHLCs` survives `onclose` (only `disconnect()` clears it), so `handleSnapshotRequired` can wait on a push from the previous socket. It is rescued because the handshake-time push re-sends everything since the un-promoted `lastSentHLC` and its ack subsumes the stale id. `NOTE:` at the site in `sync-client.ts`. Not covered by a test; the failure mode would be a recovery that stalls until the next socket close.
- **Ack never arrives, socket stays open.** If a server accepts `apply_changes` and never acks (nor errors), the recovery waits until the socket closes. Same exposure the existing `pendingSentHLCs` comment already accepts; no new mitigation.
- **Duplicate push on a racing handshake.** `snapshot_required` can arrive while the handshake's own `pushLocalChanges` is still ahead of it; both push the same unsent batch. Idempotent and acked separately; the second ack is subsumed. Observable only as two `apply_changes` on the wire.
- **Client-side false-positive warning.** After inheriting the server's floor via a snapshot, a client whose `lastSentHLC` is older than that floor logs the `getChangesSince` below-floor warning on its next push. The warning is about *inbound* completeness and does not apply to a client's own outbound facts; it stops once `lastSentHLC` advances. The ticket chose warn-not-throw and this is the cost. If it ever confuses operators, the push path could pass a flag to skip the check.
- **HTTP route has no refusal test.** `routes.ts` is a two-branch glue change on the same service decision the WebSocket test covers; the 409 shape is asserted nowhere. Cheap to add in `http.spec.ts` if a reviewer wants it, but it needs its own server with `sync.retentionHorizonMs: -1`.
- **`deltaRefusedTotal` is a plain counter with no label.** The ticket asked only for the counter; a `databaseId` label would make it useful per tenant but was not requested.
- **Protocol v2 is a flag day.** No negotiation (project rule: backwards compat not yet). Release notes written to the gitignored `.release-notes.pending.md`; a reviewer should confirm that is the intended home (per `docs/releasing.md` it is).
