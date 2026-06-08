---
description: Fix O(N*M) performance in snapshot stream table entry counting/streaming
files: packages/quereus-sync/src/metadata/keys.ts, packages/quereus-sync/src/sync/snapshot-stream.ts, packages/quereus-sync/src/index.ts
---

# Complete: O(N*M) Snapshot Stream Performance Fix

## Summary
Fixed O(N*M) performance in `streamSnapshotChunks()` where each table triggered two full scans of ALL column versions. Now uses per-table scan bounds for O(entries_per_table) per table.

## Changes
- **keys.ts**: Added `buildTableColumnVersionScanBounds(schema, table)` — scoped scan bounds using `cv:{schema}.{table}:` prefix. Follows exact pattern of existing scan-bounds functions.
- **snapshot-stream.ts**: Replaced `buildAllColumnVersionsScanBounds()` with per-table bounds in the streaming loop. Removed redundant counting pass — `estimatedEntries` is now 0 (actual count available in `table-end.entriesWritten`).
- **index.ts**: Exported `buildTableColumnVersionScanBounds` via the metadata barrel export.

## Validation
- All 151 sync tests pass (sync-manager, sync-protocol-e2e)
- Build passes cleanly
- Snapshot streaming tests cover: header/footer, chunk sizes, apply, resume, and data application flows
