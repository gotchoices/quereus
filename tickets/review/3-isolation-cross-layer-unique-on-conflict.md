description: Review cross-layer UNIQUE/PK conflict detection in IsolatedTable
prereq: none
files:
  packages/quereus-isolation/src/isolated-table.ts
  packages/quereus-store/test/isolated-store.spec.ts
  packages/quereus/test/logic.spec.ts
----

## What was built

`IsolatedTable` now detects UNIQUE and PK conflicts across the overlay+underlying boundary at write time, rather than silently overwriting at flush. The fix uses Option B (resolve at write time) so `flushOverlayToUnderlying` stays a dumb apply.

### New methods in `IsolatedTable`

- `keysEqual(a, b)` — element-wise PK comparison using `compareSqlValues`
- `getUnderlyingRow(pk)` — O(log n) point-lookup in underlying via existing `buildPKPointLookupFilter`
- `insertTombstoneForPK(overlay, pk, tombstoneIndex)` — inserts/updates a tombstone for REPLACE evictions
- `checkMergedPKConflict(overlay, newPK, tombstoneIndex, onConflict)` — checks if newPK conflicts with an un-tombstoned underlying row; returns null (no conflict or REPLACE applied) or an `UpdateResult` (IGNORE / constraint)
- `findMergedUniqueConflict(overlay, cols, newRow, selfPks, tombstoneIndex)` — full scan of underlying for a row matching the unique column values, skipping selfPks and tombstoned rows
- `checkMergedUniqueConstraints(overlay, newRow, selfPks, tombstoneIndex, onConflict)` — iterates all non-PK UNIQUE constraints, calling `findMergedUniqueConflict` for each

### Changes to `IsolatedTable.update`

**`insert` case:** when no existing overlay entry is found, calls `checkMergedPKConflict` then `checkMergedUniqueConstraints` before delegating to the overlay insert.

**`update` `else` branch** (row only in underlying): adds the same conflict checks, plus tombstones the old PK when the update changes the PK (fixing the pre-existing PK-change tombstone omission).

### Test harness

- `47-upsert.sqllogic` and `102-unique-constraints.sqllogic` removed from `MEMORY_ONLY_FILES` — both now pass in store mode
- `04-transactions.sqllogic` remains excluded with updated comment: savepoint rollback doesn't undo writes when the overlay was created after the savepoint (separate issue)

### New unit tests in `isolated-store.spec.ts`

Ten new tests covering: PK conflict error, IGNORE, REPLACE; non-PK UNIQUE error, IGNORE, REPLACE (with eviction); UPDATE changing UNIQUE column to conflicting value; composite UNIQUE; ON CONFLICT DO NOTHING; ON CONFLICT DO UPDATE.

## Test results

- Memory mode: 2443 passing (no regression)
- Store mode: 569 passing, 1 failing (pre-existing `50-declarative-schema.sqllogic` deferred-constraint ambiguity — was present before this change)
- Store unit tests: 236 passing

## Review focus areas

- `checkMergedPKConflict`: when `overlayRow` is a tombstone it returns `null` (no conflict). Verify this is correct when the tombstone is from an earlier REPLACE in the same transaction.
- `findMergedUniqueConflict`: full scan of underlying on each non-PK UNIQUE write. Acceptable for now but O(n) per write. The overlay already checks its own rows; underlying-only conflicts are the gap filled here.
- REPLACE for same-PK conflict (`checkMergedPKConflict` REPLACE case): returns null and lets the insert proceed. At flush, `existsInUnderlying` → true → becomes an UPDATE. The `replacedRow` field is not returned to the DML executor, so FK CASCADE DELETE is not triggered for same-PK REPLACE through the isolation layer.
- PK-change tombstone in `update` else branch: tombstones old PK before inserting new PK. Verify against the `41-fk-cross-schema.sqllogic` gap (FK cascades on PK-change UPDATE not handled).
- `insertTombstoneForPK` uses `fill(null)` for non-PK columns, which means the tombstone's UNIQUE columns are null → no false UNIQUE conflict when the new row is inserted after REPLACE.
