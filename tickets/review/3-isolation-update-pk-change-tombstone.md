description: UPDATE that changes the primary key inserts a new overlay row at the new PK but does not tombstone the old PK; both rows exist after merge
files:
  packages/quereus-isolation/src/isolated-table.ts
  packages/quereus-store/test/isolated-store.spec.ts
  packages/quereus/test/logic.spec.ts
----

## What was built

Fixed `IsolatedTable.update()` (`case 'update'`) to correctly handle the case where the overlay already has a row at the old PK and the UPDATE changes the PK.

### Root cause discovered during implementation

The `existingOverlayRow` branch (lines 696–730 of `isolated-table.ts`) was missing PK-change handling entirely — it just called `overlay.update({ operation: 'update', ... })` which moved the overlay row to the new PK without leaving a tombstone at the old PK.

An additional subtlety: using `insertTombstoneForPK`'s in-place update path (`recordUpsert`) failed silently when the row was inserted in the same pending transaction layer — the Inheritree BTree does not reliably replace values within the same layer via upsert. The fix uses delete-then-insert instead: remove the overlay row at the old PK, then call `insertTombstoneForPK` (which takes the insert path since the row is now absent).

### Changes

**`packages/quereus-isolation/src/isolated-table.ts`** — In `case 'update'`, the `existingOverlayRow` branch now:
- Computes `newPK` and detects PK change
- Checks for cross-layer conflict at `newPK` via `checkMergedPKConflict`
- Checks unique constraints via `checkMergedUniqueConstraints`
- Deletes the existing overlay row at `targetPK`
- Inserts a tombstone at `targetPK` via `insertTombstoneForPK`
- Inserts the new row at `newPK`

**`packages/quereus-store/test/isolated-store.spec.ts`** — New `UPDATE that changes the primary key` describe block with four tests:
- PK change from underlying row (no prior overlay): commit and rollback paths
- PK change after non-PK update in same transaction (existingOverlayRow path)
- Composite PK change

**`packages/quereus/test/logic.spec.ts`** — Removed `41-fk-cross-schema.sqllogic` from `MEMORY_ONLY_FILES`.

## Validation

- `yarn test` — all 2443 passing (memory-backed tests) + 12 pending
- `yarn test:store` — 2433 passing, 12 pending, no regressions
- All 4 new PK-change unit tests pass
- `41-fk-cross-schema.sqllogic` now runs (and passes) in store mode

## Test cases (use for review)

1. `UPDATE t SET id = 2 WHERE id = 1` with underlying row (1, 'A'): inside transaction, only (2, 'A') visible; after COMMIT, underlying has (2, 'A'); after ROLLBACK, underlying has (1, 'A').
2. Same as above but preceded by `UPDATE t SET name = 'B' WHERE id = 1` in the same transaction: only (2, 'B') visible after the PK change.
3. Composite PK: `UPDATE t SET a=2, b=2 WHERE a=1 AND b=1` → only (2,2) visible.
4. `41-fk-cross-schema.sqllogic`: `UPDATE s2.items SET id = 99 WHERE id = 2` → rows are (1) and (99).
