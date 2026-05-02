description: UPDATE that changes the primary key inserts a new overlay row at the new PK but did not tombstone the old PK; both rows existed after merge — fixed
files:
  packages/quereus-isolation/src/isolated-table.ts
  packages/quereus-store/test/isolated-store.spec.ts
  packages/quereus/test/logic.spec.ts
----

## What was built

Fixed `IsolatedTable.update()` (`case 'update'`) so that when the overlay already has a live row at the old PK and the UPDATE changes the PK, the overlay correctly tombstones the old PK in addition to inserting a row at the new PK.

### Root cause

The `existingOverlayRow` branch (lines 696–730 of `isolated-table.ts`) was missing PK-change handling entirely — it just delegated to `overlay.update({ operation: 'update', ... })`, which moved the overlay row to the new PK without leaving anything to shadow the underlying row at the old PK.

A secondary subtlety: using `insertTombstoneForPK`'s in-place update path (`recordUpsert`) failed silently when the row was inserted in the same pending transaction layer — the Inheritree BTree does not reliably replace a value within the same layer via upsert. The fix uses delete-then-insert: remove the overlay row at the old PK, then call `insertTombstoneForPK`, which then takes the insert path because the row is absent.

### Changes

**`packages/quereus-isolation/src/isolated-table.ts`** — In `case 'update'`, the `existingOverlayRow` branch now:
- Computes `newPK` and detects PK change via `keysEqual`
- Checks for cross-layer conflict at `newPK` via `checkMergedPKConflict`
- Checks unique constraints via `checkMergedUniqueConstraints` (passing both `targetPK` and `newPK` as self-PKs)
- Deletes the existing overlay row at `targetPK`
- Inserts a tombstone at `targetPK` via `insertTombstoneForPK`
- Inserts the new row at `newPK`

The same-PK path is unchanged.

**`packages/quereus-store/test/isolated-store.spec.ts`** — New `UPDATE that changes the primary key` describe block with four tests covering the existingOverlayRow path, the no-overlay path, rollback, and composite PK.

**`packages/quereus/test/logic.spec.ts`** — Removed `41-fk-cross-schema.sqllogic` from `MEMORY_ONLY_FILES`; it now passes in store mode.

## Validation

- `yarn test` — all default tests pass (memory-backed)
- `yarn test:store` — 2436 passing, 9 pending, no regressions
- All 4 new PK-change unit tests pass (verified individually with spec reporter)
- `41-fk-cross-schema.sqllogic` runs and passes in store mode

## Review notes

- Verified delete-on-missing semantics in both memory and store modules: both return `{status: 'ok'}` for a `delete` on a row that doesn't exist, and `flushOverlayToUnderlying` does not check the result. This means the rare "INSERT then UPDATE-changes-PK in the same transaction" case (where the tombstone targets a PK that has no underlying row) is functionally correct even though it issues a wasteful no-op delete at flush.
- The comment at lines 710-713 documents the BTree same-layer upsert subtlety that motivates delete-then-insert — non-obvious, so the comment is warranted.
- Minor follow-up not pursued: the `existingOverlayRow` and `else` branches share PK-change conflict/tombstone logic that could be DRYed with a helper. Out of scope for this fix.

## Test cases (regression)

1. `UPDATE t SET id = 2 WHERE id = 1` with underlying row (1, 'A'): inside transaction, only (2, 'A') visible; after COMMIT, underlying has (2, 'A'); after ROLLBACK, underlying still has (1, 'A').
2. Same as above preceded by `UPDATE t SET name = 'B' WHERE id = 1` in the same transaction (existingOverlayRow path): only (2, 'B') visible after the PK change.
3. Composite PK: `UPDATE t SET a=2, b=2 WHERE a=1 AND b=1` → only (2,2) visible.
4. `41-fk-cross-schema.sqllogic`: `UPDATE s2.items SET id = 99 WHERE id = 2` → rows are (1) and (99) in store mode.
