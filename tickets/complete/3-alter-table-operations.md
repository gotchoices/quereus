---
description: ALTER TABLE operations (RENAME TABLE, RENAME COLUMN, ADD COLUMN, DROP COLUMN) — reviewed and complete
prereq: none
---

## Summary

Four ALTER TABLE operations implemented and reviewed: RENAME TABLE, RENAME COLUMN, ADD COLUMN, DROP COLUMN.

### Architecture

- **Plan node**: `AlterTableNode` with discriminated action union — clean, type-safe, minimal
- **Planner**: `buildAlterTableStmt()` routes all 4 actions; `addConstraint` handled separately by `AddConstraintNode`
- **Runtime emitter**: `emitAlterTable()` dispatches to per-action runners with proper validation
- **Module interface**: `VirtualTableModule.alterTable()` optional method for data-affecting changes; RENAME TABLE is schema-only
- **MemoryTableManager**: Latch-based concurrency, schema rollback on error, base layer data migration

### Key Design Points

- RENAME TABLE updates schema catalog + module's internal table map key — no data migration
- RENAME COLUMN uses `buildConstraintsFromColumn()` to reconstruct AST from ColumnSchema, delegates to module for data-level changes with schema-only fallback
- ADD COLUMN validates: no duplicates, no PK, NOT NULL requires DEFAULT (unless table is empty — SQLite-compatible)
- DROP COLUMN validates: no PK drop, not last column; adjusts PK definitions and secondary index column indices

### Bug Fix

Stale `readLayer` in `ensureConnection()` — syncs with `manager.currentCommittedLayer` when reusing a connection that was disconnected from the manager's map but remained in the DB registry.

### Testing

- `test/logic/41-alter-table.sqllogic` — comprehensive coverage of all 4 operations, error cases, combined operations
- `test/vtab-events.spec.ts` — event emission for all 4 operations
- 731 tests passing, 0 failing

### Key Files

- `packages/quereus/src/planner/nodes/alter-table-node.ts`
- `packages/quereus/src/runtime/emit/alter-table.ts`
- `packages/quereus/src/planner/building/alter-table.ts`
- `packages/quereus/src/vtab/module.ts`
- `packages/quereus/src/vtab/memory/module.ts`
- `packages/quereus/src/vtab/memory/table.ts`
- `packages/quereus/src/vtab/memory/layer/manager.ts`
- `packages/quereus/test/logic/41-alter-table.sqllogic`
- `docs/sql.md` (section 2.7)
