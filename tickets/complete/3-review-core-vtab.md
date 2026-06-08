---
description: Comprehensive review of virtual table subsystem (VTab interface, Memory table, cursors)
prereq: none

---

# Virtual Table Subsystem Review

## Goal

Adversarial review of the virtual table subsystem to ensure interface correctness, MVCC isolation accuracy, and constraint pushdown reliability. Verify MemoryTable implementation correctness and event system reliability.

## Scope

- **VTab interface**: Core interfaces and types (`src/vtab/`)
- **Memory table**: MVCC implementation (`src/vtab/memory/`)
- **Infrastructure**: Constraint handling, index info, module wrapper

## Findings and Actions

### Dead Code Removal

- [x] **Old xBestIndex-style planning methods**: Removed 17 private dead methods from `MemoryTableModule` (module.ts) that were vestiges of the old `xBestIndex` API. These were all unreachable - only called by each other, never from `getBestAccessPlan` or any external code. Reduced file from 714 to ~395 lines.
- [x] **Unused `buildColumnMetadata`**: Removed private method and unused `ColumnMeta` import from module.ts.
- [x] **Monkey-patched Row properties**: Removed `shouldSkipPkCheck()` and `cleanConflictResolutionFromValues()` from manager.ts. These checked for `_skipPkCheck` and `_onConflict` properties monkey-patched onto Row objects, but no code ever set them. Also violated project rules against monkey-patching.
- [x] **Unused imports**: Removed `IndexConstraintOp`, `IndexInfo`, and `createLogger` imports that were only referenced by dead code.

### Code Quality

- [x] **scan-plan.ts refactored**: `buildScanPlanFromFilterInfo` was extremely dense single-line code with chained operations and single-letter variables. Refactored into 12 clean, well-named helper functions: `parseIdxStrParameters`, `parseArgvMappings`, `resolveIndexName`, `resolveIndexSchema`, `isDescendingScan`, `findArgValueForColumn`, `findConstraintValueForColumn`, `buildEqualityKey`, `buildCompositeEqualityKey`, `isLowerBoundOp`, `isUpperBoundOp`, `extractRangeBounds`. Same behavior, dramatically improved readability.
- [x] **Indentation consistency**: Fixed mixed spaces/tabs indentation in `findBestAccessPlan` and `indexSatisfiesOrdering` methods in module.ts.
- [x] **Fragile `as any` casts removed**:
  - `TransactionLayer.clearBase()`: Removed defensive `typeof` check and `as any` cast. `BTree.clearBase()` is declared in inheritree's type definitions.
  - `MemoryIndex.clearBase()`: Same fix - direct call instead of `as any` cast.
  - `MemoryIndex.clear()`: Fixed bug where it accessed `(this.data as any).baseTable` (wrong field name - the field is `base`, and it's private). The BTree with wrong-named base was always created without inheritance, effectively just creating a fresh empty tree. Simplified to just create a fresh BTree with no base argument.
- [x] **getConnection() allocation**: `MemoryTable.getConnection()` was creating a new `MemoryVirtualTableConnection` wrapper on every call. Added caching with invalidation when the underlying connection changes.

### Interface Review Observations

The VTab interface is well-designed with clean separation between:
- Module (factory) vs Table (instance) vs Connection (transaction state)
- The `VTableEventEmitter` interface's all-optional methods pattern is pragmatic for consumers that only need a subset
- `BestAccessPlanRequest`/`BestAccessPlanResult` is a good modern replacement for the old IndexInfo-based API
- `AccessPlanBuilder` with validation provides a safe construction pattern

### MVCC / Layer Architecture

The layer-based MVCC model using inheritree is sound:
- BaseLayer holds canonical data
- TransactionLayer inherits from parent with copy-on-write BTrees
- Savepoints create full snapshots (deep copy) for rollback
- Layer collapse is best-effort with lock timeouts to avoid blocking
- Commit uses latch-based concurrency control with stale detection

### Additional Verification (Post-Review)

Several potential issues were investigated and resolved or ruled out:

- **Ordering plan "discount"**: Investigated whether `adjustPlanForOrdering` could falsely claim ordering without switching the scan to the right index. Verified the planner's `rule-select-access-path.ts` correctly uses `orderingIndexName` to construct the appropriate `IndexScanNode`. Not a bug - two-tier architecture is correct.
- **`resolveIndexSchema` sentinel fallback**: The `?? [{ index: -1 }]` fallback for `primaryKeyDefinition` was dead code since the field is non-optional (`ReadonlyArray<...>`). Removed.
- **Event batching architecture**: Investigated whether MemoryTableManager should call `startBatch`/`flushBatch`. Verified batching is correctly handled at the database level by `DatabaseEventEmitter` in `database-transaction.ts`. Two-tier event architecture is intentional and correct.

### Remaining Opportunities (Deferred)

- [ ] **Extended constraint pushdown**: `getBestAccessPlan` only handles `=` and range operators. `IS NULL`, `IS NOT NULL`, `IN` could benefit from index-aware planning. See `tasks/plan/vtab-extended-constraint-pushdown.md`.
- [ ] **Cost model sanity**: Cost estimates in `evaluateIndexAccess` use fixed heuristics (e.g., `estimatedTableSize / 4` for range rows). Could benefit from actual statistics.
- [ ] **Layer collapse completeness**: The `cleanupUnreferencedLayers` method is a no-op relying on GC. For long-running systems with many transactions, explicit layer tracking could prevent memory pressure.
- [ ] **VTab interface tests**: No dedicated interface contract tests exist (though integration coverage via sqllogic tests is good).

## Test Validation

All 406 existing tests pass with 0 failures after all changes. The existing test coverage for the vtab subsystem includes:
- `test/memory-vtable.spec.ts`: CRUD, constraints, composite PKs, secondary indexes, transactions, savepoints, schema changes, data types, read-only, cleanup
- `test/vtab-events.spec.ts`: Data/schema change events, batching, rollback, changedColumns tracking
- `test/logic/05-vtab_memory.sqllogic`: PK lookups, range scans, ORDER BY with indexes, transactions, multiple constraints

## Files Modified

- `packages/quereus/src/vtab/memory/module.ts` - Dead code removal, unused imports, indentation
- `packages/quereus/src/vtab/memory/layer/scan-plan.ts` - Full refactor for readability
- `packages/quereus/src/vtab/memory/layer/manager.ts` - Dead code removal, unused imports
- `packages/quereus/src/vtab/memory/layer/transaction.ts` - Removed `as any` casts
- `packages/quereus/src/vtab/memory/index.ts` - Removed `as any` casts, fixed bug in `clear()`
- `packages/quereus/src/vtab/memory/table.ts` - Cached getConnection() wrapper
