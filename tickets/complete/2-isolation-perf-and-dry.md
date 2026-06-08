description: O(n) → O(log n) perf fixes and DRY cleanup in isolation layer
files:
  - packages/quereus-isolation/src/isolated-table.ts
  - packages/quereus-isolation/src/isolation-types.ts
  - packages/quereus-isolation/README.md
  - docs/design-isolation-layer.md
---

# Isolation Layer Performance and DRY Fixes — Complete

## What was built

### O(n) → O(log n) Performance Fixes

- **`getOverlayRow()`** and **`rowExistsInUnderlying()`**: Use `buildPKPointLookupFilter(pk)` — a FilterInfo producing an equality seek on the PK index — instead of full table scans. O(log n) per call.
- **`clearOverlay()`**: Replaced O(n) iterate-and-delete with `clearConnectionOverlay()` reference discard. O(1).
- **`buildPKPointLookupFilter(pk)`**: New helper constructing a FilterInfo for PK equality seeks. Works for single and composite PKs.

### DRY Fixes

- **Commit/rollback paths unified**: `flushAndClearOverlay()` shared by `commit()` and `onConnectionCommit()`.
- **`stripTombstoneFromResult()`**: Extracted from 4 repeated inline blocks in `update()`.
- **Delete arm double lookup eliminated**: Was calling `rowExistsInOverlay()` then `getOverlayRow()` with same PK. Now single `getOverlayRow()` call.
- **Dead `IsolatedTableState` type removed** from `isolation-types.ts`.
- **Savepoint dual-path risk fixed**: Table-level savepoint methods forward only to underlying; overlay savepoints managed by `IsolatedConnection`.

## Review findings addressed

- Extracted `stripTombstoneFromResult()` helper (DRY)
- Eliminated double PK lookup in delete arm (perf + DRY)
- Removed unused `IsolatedTableState` interface and its unused `VirtualTable` import
- Updated README.md performance section (O(n) → O(log n))
- Updated design doc Phase 6 checklist to mark implemented optimizations

## Testing

- All 60 isolation layer tests pass (CRUD, composite PKs, savepoints, secondary indexes, commit/rollback, autocommit, delete-then-reinsert, sequential transactions)
- All 121 monorepo tests pass
- Build succeeds

## Key files

- `packages/quereus-isolation/src/isolated-table.ts` — core implementation
- `packages/quereus-isolation/test/isolation-layer.spec.ts` — integration tests
- `packages/quereus-isolation/README.md` — updated performance docs
- `docs/design-isolation-layer.md` — updated Phase 6 checklist
