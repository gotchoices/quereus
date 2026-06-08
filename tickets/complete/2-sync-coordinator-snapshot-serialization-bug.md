---
description: Fixed BigInt serialization bug in sync-coordinator snapshot endpoints
prereq: none
files:
  - packages/sync-coordinator/src/common/serialization.ts
  - packages/sync-coordinator/src/common/index.ts
  - packages/sync-coordinator/src/server/websocket.ts
  - packages/sync-coordinator/src/server/routes.ts
  - packages/sync-coordinator/test/websocket.spec.ts
---

# Snapshot Serialization Bug — Complete

## Problem

WebSocket and HTTP snapshot endpoints failed with `"Do not know how to serialize a BigInt"` because raw `SnapshotChunk` objects (containing `HLC` with `bigint wallTime` and `SiteId` as `Uint8Array`) were passed directly to `JSON.stringify()`.

## Fix

Added `serializeSnapshotChunk()` in `serialization.ts` alongside the existing `serializeChangeSet()`. It handles each chunk type:

- **header**: serializes `siteId` → base64url, `hlc` → base64
- **column-versions**: serializes each entry's HLC → base64
- **schema-migration**: serializes `migration.hlc` → base64
- **table-start, table-end, footer**: passed through unchanged (no binary fields)

Wired the serializer into websocket.ts and routes.ts.

## Review Fixes

During review, two additional issues were corrected:

1. **Chunk type overwriting**: The original fix used `{ ...serializeSnapshotChunk(chunk), type: 'snapshot_chunk' }` which overwrote the chunk's internal `type` field (e.g., 'header', 'column-versions'). Fixed to nest the chunk per the documented wire format: `{ type: 'snapshot_chunk', chunk: serializeSnapshotChunk(chunk) }`.

2. **DRY violation in routes.ts**: The HTTP GET/POST changes endpoints had inline changeset serialization/deserialization that duplicated `serializeChangeSet()`/`deserializeChangeSet()` from `serialization.ts`. Replaced with shared functions.

3. **Doc consistency**: Updated `docs/sync.md` snapshot_chunk payload description to match `docs/sync-coordinator.md` nested format.

## Validation

- `yarn workspace @quereus/sync-coordinator build` — clean
- `yarn workspace @quereus/sync-coordinator test` — 103 passing
