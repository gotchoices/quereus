---
description: Comprehensive review of isolation package (MVCC, transactions)
prereq: review-core-vtab

---

# Isolation Package Review

## Goal

Adversarial review of the `@quereus/isolation` package: verify isolation correctness, test from interface without implementation bias, inspect code quality, and ensure documentation accuracy.

## Scope

- **Source**: `packages/quereus-isolation/src/` — IsolationModule, IsolatedTable, IsolatedConnection, merge iterator, types
- **Tests**: `packages/quereus-isolation/test/` — isolation-layer.spec.ts, merge-iterator.spec.ts
- **Docs**: `packages/quereus-isolation/README.md`, `docs/design-isolation-layer.md`

## Tests Added

Added 15 interface-driven tests to `isolation-layer.spec.ts` (57 total, up from ~42):

### Savepoints (5 tests, 2 skipped as bugs)
- Create and release savepoint
- Rollback to savepoint restores state
- Nested savepoints rollback independently (**SKIP — BUG**: overlay `rollbackTo` does not restore prior state)
- Rollback to savepoint then continue with new changes
- Savepoint with update and delete operations (**SKIP — BUG**: overlay `rollbackTo` does not restore deleted/updated rows)

### Compound Primary Keys (2 tests)
- CRUD operations with composite PKs
- Composite PK isolation within transaction (rollback discards)

### Transaction Edge Cases (8 tests, 1 skipped as bug)
- Empty transaction commit (no-op)
- Empty transaction rollback (no-op)
- Sequential transactions see committed data
- Autocommit individual statements
- Read-only queries without overlay
- Delete-all then re-insert (**SKIP — BUG**: insert does not check for existing tombstone, causes PK conflict)
- Update then delete same row within transaction
- Insert then update same row within transaction

## Bugs Found (3)

All three have failing tests (marked `.skip`) and follow-up task: `tasks/fix/isolation-overlay-bugs.md`

1. **Savepoint rollback loses prior overlay state** — `ROLLBACK TO SAVEPOINT sp_inner` discards changes from before the inner savepoint, not just after it.
2. **Savepoint rollback doesn't restore tombstoned/updated rows** — Delete then rollback-to-savepoint doesn't restore the deleted row.
3. **Insert after delete causes UNIQUE constraint violation** — `update()` insert path doesn't check for existing tombstone in overlay; tries to insert a new row at a PK that already has a tombstone row.

## Code Quality Findings

Follow-up task: `tasks/fix/isolation-perf-and-dry.md`

### Performance
- **`getOverlayRow()`**: O(n) full table scan to find a row by PK (should be PK point lookup)
- **`rowExistsInUnderlying()`**: O(n) full table scan for existence check (design doc Optimization 3 documents the fix)
- **`clearOverlay()`**: Deletes rows one by one; could destroy/recreate the overlay table

### DRY Violations
- `commit()` and `onConnectionCommit()` have identical flush+clear logic
- `rollback()` and `onConnectionRollback()` have identical clear logic
- `savepoint()/release()/rollbackTo()` vs `onConnectionSavepoint()` etc. operate on different targets (both vs overlay-only), risking double-savepointing

### Minor
- Module-level mutable counters (`overlayIdCounter`, `connectionIdCounter`) persist across tests

## Documentation Updates

- **README line 194**: Fixed performance claim from "O(log n) overlay check" to "Currently O(n) full scan (PK point lookup optimization planned)"
- **Design doc**: Accurate — already documents the O(n) issue and proposed fix in Phase 6 optimization section
- **Phase 5**: One remaining item (full integration testing with autocommit and savepoint coordination)
- **Phase 6**: Not started (optimization strategies)

## Architecture Assessment

The overlay-based isolation architecture is sound:
- Clean separation: IsolationModule (factory), IsolatedTable (instance), IsolatedConnection (transaction coordination)
- Merge iterator is well-implemented with proper iterator cleanup
- Lazy overlay creation avoids overhead for read-only transactions
- Per-connection overlay via WeakMap-based DB ID tracking works correctly
- Fast path bypasses merge when no writes have occurred
- Configurable overlay module (memory default, persistent option) is a good design

## Files Modified

- `packages/quereus-isolation/test/isolation-layer.spec.ts` — Added 15 tests (3 skipped as known bugs)
- `packages/quereus-isolation/README.md` — Fixed inaccurate performance claim

## Follow-Up Tasks Created

- `tasks/fix/isolation-overlay-bugs.md` — Three bugs with failing tests
- `tasks/fix/isolation-perf-and-dry.md` — O(n) scans, DRY violations, clearOverlay optimization

## Test Validation

57 passing, 3 pending (known bugs marked `.skip`). Run with:
```bash
node --import ./packages/quereus-isolation/register.mjs node_modules/mocha/bin/mocha.js "packages/quereus-isolation/test/**/*.spec.ts" --colors
```

