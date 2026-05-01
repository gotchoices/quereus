description: Enforce non-PK UNIQUE constraints in StoreTable's INSERT and UPDATE paths.
files:
  packages/quereus-store/src/common/store-table.ts (added checkUniqueConstraints / findUniqueConflict / deleteRowAt / uniqueColumnsChanged; wired into insert + same-PK update + PK-change update branches)
  packages/quereus-store/src/common/transaction.ts (added getPendingOpsForStore for intra-transaction visibility)
  packages/quereus-store/test/unique-constraints.spec.ts (new spec — 5 cases)
  packages/quereus/test/logic.spec.ts (refined 102-unique-constraints exclusion comment to scope to isolation overlay)
----

## What was built

`StoreTable.update` previously only honored primary-key collision; `tableSchema.uniqueConstraints` was ignored, so duplicate non-PK UNIQUE values were silently accepted. This change wires UNIQUE enforcement into all three update branches.

`checkUniqueConstraints(inTransaction, newRow, selfPks, onConflict)` is the central gate. It iterates `tableSchema.uniqueConstraints`, skipping any constraint where the new row has NULL in a covered column (SQL-standard semantics). For each remaining constraint, `findUniqueConflict` does a primary-data scan, overlaying the transaction coordinator's pending ops (last-write-wins via `getPendingOpsForStore`) and skipping rows whose PK is in `selfPks`. On conflict:

- `IGNORE` → `{status:'ok', row:undefined}` (no mutation, no event)
- `REPLACE` → `deleteRowAt(...)` evicts the conflicting row (data + secondary indexes + stats + delete event), then continues to the next constraint
- default → `{status:'constraint', constraint:'unique', message, existingRow}` with covered column names in the message

Wiring:

- INSERT — runs the UNIQUE check after the existing PK collision branch, with `selfPks=[pk]`.
- UPDATE same-PK — runs the check only when `uniqueColumnsChanged(oldRow, newRow)` is true, with `selfPks=[oldPk]` so the row being updated isn't a self-conflict.
- UPDATE PK-change — runs an INSERT-style PK collision check at the new key first, then the UNIQUE check with `selfPks=[oldPk, newPk]` so the relocation doesn't false-conflict against itself.

Transaction-pending visibility: `TransactionCoordinator.getPendingOpsForStore(store?)` returns last-write-wins `{puts, deletes}` keyed by hex-encoded keys, scoped to a target store (defaults to the coordinator's data store). `findUniqueConflict` overlays this on committed iteration so duplicates inserted earlier in the same transaction are detected before commit and rows pending-deleted aren't false-flagged.

## Key files

- `packages/quereus-store/src/common/store-table.ts:573-792` — `update` method with three wired branches
- `packages/quereus-store/src/common/store-table.ts:859-868` — `uniqueColumnsChanged` (compareSqlValues-based)
- `packages/quereus-store/src/common/store-table.ts:883-915` — `checkUniqueConstraints`
- `packages/quereus-store/src/common/store-table.ts:922-963` — `findUniqueConflict` (overlay scan)
- `packages/quereus-store/src/common/store-table.ts:970-998` — `deleteRowAt` (REPLACE eviction)
- `packages/quereus-store/src/common/transaction.ts:228-245` — `getPendingOpsForStore`

## Validation

Test runs at completion:

- `yarn workspace @quereus/store test` — 216 passing (5 new specs in `unique-constraints.spec.ts`).
- `yarn workspace @quereus/quereus test` (memory mode) — 2443 passing, 2 pending, no regressions.
- `yarn workspace @quereus/quereus lint` — 0 errors (pre-existing `no-explicit-any` warnings only).

Test cases covered in `packages/quereus-store/test/unique-constraints.spec.ts`:

- single-column UNIQUE: rejects duplicate INSERT; INSERT OR IGNORE silently skips; INSERT OR REPLACE evicts conflicting row and inserts new one.
- NULL semantics: multiple NULLs allowed in the same UNIQUE column; non-NULL duplicates rejected.
- UPDATE same-PK: rejects update to a conflicting value; allows update of UNIQUE column to its own value (no self-conflict); allows update to a fresh value; skips check when only non-UNIQUE columns change.
- composite UNIQUE on `(a, b)`: rejects duplicate combinations; partial overlap allowed.
- PK-change UPDATE: rejects when new value collides on UNIQUE; allows clean PK changes; old row preserved on rejection.

## Usage notes

UNIQUE constraint enforcement now works through `StoreTable` directly. Note that the `102-unique-constraints.sqllogic` test remains in the store-mode exclusion list (`packages/quereus/test/logic.spec.ts:60`) — basic-rejection scenarios pass through the isolation layer once StoreTable enforces UNIQUE, but the REPLACE-through-overlay path remains broken because `IsolatedTable.flushOverlayToUnderlying` calls `underlyingTable.update({operation:'insert'})` without forwarding `onConflict`. That's a separate isolation-layer follow-up.

## Follow-ups for future tickets

- Isolation layer: `IsolatedTable.flushOverlayToUnderlying` should forward `onConflict` so REPLACE flows correctly across the overlay (would re-enable `102-unique-constraints.sqllogic` in store mode).
- Optional: hex-encode helper (`bytesToHex` / `keyToHex`) is duplicated across `memory-store.ts`, `transaction.ts`, `store-table.ts`. Could be promoted to a shared util.
- Optional: backing index store for UNIQUE constraints could replace the full-scan path on large tables (Option B per the original plan).
