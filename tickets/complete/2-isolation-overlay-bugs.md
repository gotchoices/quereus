---
description: Fixed three isolation layer overlay bugs (savepoint rollback, insert-after-delete)
prereq: packages/quereus-isolation/src/isolated-table.ts, packages/quereus-isolation/src/isolated-connection.ts
---

# Isolation Layer Overlay Bug Fixes — Complete

## Bugs Fixed

### 1 & 2: Savepoint rollback did not restore prior overlay state

Two issues with savepoint coordination:
- **Double-push:** Both the overlay's registered `MemoryVirtualTableConnection` and `onConnectionSavepoint → overlayTable.savepoint()` called `createSavepoint` on the same connection, doubling entries in `savepointStack`.
- **Savepoint before overlay:** Savepoints created before any writes recorded no snapshot; overlay created by a later write had no savepoint to restore.

**Fix:** `savepointsBeforeOverlay: Set<number>` tracks pre-overlay savepoint depths. `onConnectionSavepoint` is a no-op when overlay exists (its registered connection handles it). `onConnectionRollbackToSavepoint` clears the entire overlay when rolling back to a pre-overlay savepoint.

### 3: Insert after delete caused UNIQUE constraint violation

When a row was deleted (tombstone inserted) then re-inserted with the same PK, the overlay already had a row with that PK.

**Fix:** Before inserting, check `getOverlayRow(pk)`. If a tombstone exists, switch to an `update` operation to convert the tombstone back to a regular row.

## Files Changed

- `packages/quereus-isolation/src/isolated-table.ts` — All three fixes
- `packages/quereus-isolation/test/isolation-layer.spec.ts` — Three tests unskipped

## Validation

- `npm test --workspace=packages/quereus-isolation`: 60/60 passing
- `npm test --workspace=packages/quereus`: 684 passing, 7 pending (pre-existing)
- `npm run build --workspace=packages/quereus-isolation`: clean

## Key Tests

- `'nested savepoints rollback independently'` — sp_outer/sp_inner rollback independently
- `'savepoint with update and delete operations'` — UPDATE + DELETE rolled back to original state
- `'delete-all then re-insert works'` — delete then re-insert same PK without UNIQUE violation
