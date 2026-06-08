---
description: Resolved DRY violations in sync-coordinator (serialization, storage path resolver, hasSnapshot stub)
files:
  - packages/sync-coordinator/src/common/serialization.ts (new)
  - packages/sync-coordinator/src/common/index.ts
  - packages/sync-coordinator/src/service/s3-config.ts
  - packages/sync-coordinator/src/service/s3-batch-store.ts
  - packages/sync-coordinator/src/service/s3-snapshot-store.ts
  - packages/sync-coordinator/src/service/coordinator-service.ts
  - packages/sync-coordinator/src/server/websocket.ts
  - packages/sync-coordinator/src/service/index.ts
  - packages/sync-coordinator/src/index.ts
  - packages/sync-coordinator/test/serialization.spec.ts (new)
  - packages/sync-coordinator/test/s3-config.spec.ts (updated)
---

# Completed: Sync Coordinator DRY Violations

## Changes

1. **Extracted `serializeChangeSet` / `deserializeChangeSet` / `serializeSnapshotChunk`** into `src/common/serialization.ts`. Both `websocket.ts` and `coordinator-service.ts` now import from the shared module.

2. **Extracted `StoragePathResolver` type and `defaultStoragePathResolver`** into `s3-config.ts` (existing shared S3 config module). Both `s3-batch-store.ts` and `s3-snapshot-store.ts` import from there. Re-exported via `service/index.ts` and root `index.ts`.

3. **Implemented `hasSnapshot()`** in `S3SnapshotStore` using `ListObjectsV2Command` with `MaxKeys: 1` (replacing stub that always returned `false`).

## Testing

- Added `test/serialization.spec.ts` — 7 tests covering serialize/deserialize round-trip, JSON-safety, empty collections, and all snapshot chunk types.
- Added 5 `defaultStoragePathResolver` tests to `test/s3-config.spec.ts` covering colon replacement, special character sanitization, and edge cases.
- All 103 tests pass. Build clean.
