description: Sync-coordinator error handling improvements — complete
prereq: none
files:
  - packages/sync-coordinator/src/server/websocket.ts
  - packages/sync-coordinator/src/server/routes.ts
  - packages/sync-coordinator/src/service/coordinator-service.ts
  - packages/sync-coordinator/src/metrics/coordinator-metrics.ts
  - packages/sync-coordinator/test/websocket.spec.ts
  - packages/sync-coordinator/test/http.spec.ts
  - docs/sync-coordinator.md
  - packages/sync-coordinator/README.md
---

# Sync-Coordinator Error Handling — Complete

## What was built

Five error handling improvements to the sync-coordinator package:

1. **Individual try-catch per WS handler** — Each handler (`handleGetChanges`, `handleApplyChanges`, `handleGetSnapshot`, `handleResumeSnapshot`) has its own try-catch with specific error codes (`GET_CHANGES_ERROR`, `APPLY_CHANGES_ERROR`, `SNAPSHOT_ERROR`). `snapshot_complete` only sent on success.

2. **HTTP snapshot error chunk** — `routes.ts` catch block writes `{ error: message }` as an NDJSON line before `reply.raw.end()`, allowing clients to detect truncated snapshots.

3. **Broadcast error handling** — `broadcastChanges()` wraps individual `socket.send()` in try-catch. Logs with `serviceLog`, increments `broadcastErrorsTotal` counter metric.

4. **`resume_snapshot` handler** — WS handler with auth check, streaming via `service.resumeSnapshotStream()`. Service method delegates to `syncManager.resumeSnapshotStream(checkpoint)` with authorization, store management, and metrics.

5. **Tests** — `resume_snapshot` without auth → `NOT_AUTHENTICATED`; unknown message → `UNKNOWN_MESSAGE`; all existing tests pass.

## Review notes

- Code follows consistent patterns across all handlers
- Broadcast error handling correctly isolates per-socket failures
- Store acquire/release uses try/finally throughout
- `readyState === 1` check before broadcast send prevents unnecessary throws
- Metrics (`broadcastErrorsTotal`, `snapshotRequestsTotal`, `snapshotChunksTotal`) properly registered and tracked
- Doc gaps fixed: added `snapshot_complete` to WS protocol docs, added missing metrics to README

## Testing

- `yarn workspace @quereus/sync-coordinator build` — passes
- `yarn workspace @quereus/sync-coordinator test` — 103 passing
