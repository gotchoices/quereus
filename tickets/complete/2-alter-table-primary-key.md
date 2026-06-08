description: ALTER TABLE ... ALTER PRIMARY KEY support with rebuild fallback
files:
  packages/quereus/src/parser/ast.ts
  packages/quereus/src/parser/parser.ts
  packages/quereus/src/emit/ast-stringify.ts
  packages/quereus/src/planner/nodes/alter-table-node.ts
  packages/quereus/src/planner/building/alter-table.ts
  packages/quereus/src/runtime/emit/alter-table.ts
  packages/quereus/src/vtab/module.ts
  packages/quereus/src/vtab/memory/module.ts
  packages/quereus/src/vtab/memory/table.ts
  packages/quereus/src/vtab/memory/layer/manager.ts
  packages/quereus/src/vtab/memory/layer/base.ts
  packages/quereus/src/schema/schema-differ.ts
  packages/quereus/src/schema/catalog.ts
  packages/quereus-store/src/common/store-module.ts
  packages/quereus/test/logic/41.1-alter-pk.sqllogic
  packages/quereus/test/logic/50.1-declare-schema-pk.sqllogic
  docs/sql.md
  docs/memory-table.md
  docs/module-authoring.md
---

## Summary

`ALTER TABLE <name> ALTER PRIMARY KEY (<col> [ASC|DESC], ...)` — changes a table's primary key definition. Empty PK `()` reverts to implicit key.

### Design

- **Module contract**: `SchemaChangeInfo` variant `{ type: 'alterPrimaryKey' }` lets modules handle re-keying natively. Modules throw `UNSUPPORTED` to trigger the generic rebuild fallback.
- **MemoryTable rebuild**: Copies rows directly through the manager API (bypassing SQL) to avoid transaction-layer isolation issues.
- **Schema differ**: Detects PK changes (column set, order, direction) and emits `ALTER PRIMARY KEY` in correct order: ADD COLUMN -> ALTER PRIMARY KEY -> DROP COLUMN.

### Bug fixes included

1. `MemoryTableManager.renameTable` — now updates `tableSchema.name` so subsequent catalog writes use the correct key.
2. `MemoryTableManager.dropColumn` — PK definition filter correctly handles column index remapping.
3. `BaseLayer.updateSchema` — reinitializes `primaryKeyFunctions` after schema changes.

### Review fixes

1. Removed duplicate `initializePrimaryKeyFunctions()` call in `BaseLayer.updateSchema()` (`base.ts`).
2. Fixed shadow table DDL generation for empty PK case — was emitting invalid `primary key ()` in CREATE TABLE; now omits the PK clause entirely (`alter-table.ts`).
3. Removed unused `IndexSchema` import (`alter-table.ts`).

### Known limitations

- Secondary indexes are cleared during rebuild (`indexes: Object.freeze([])`). This is acceptable since the B-tree is reconstructed, but module authors should be aware.

## Testing

- `test/logic/41.1-alter-pk.sqllogic` — 10 test scenarios: empty table rekey, populated table rekey, duplicate-key violation, empty PK, nullable column rejection, DESC direction, composite PK, nonexistent column, duplicate column, parser round-trip.
- `test/logic/50.1-declare-schema-pk.sqllogic` — 4 declarative schema scenarios: rekey without column changes, rekey + column drop, PK reorder, round-trip consistency.
- All 1917 tests pass. Build and lint clean.

## Usage

```sql
ALTER TABLE orders ALTER PRIMARY KEY (code)
ALTER TABLE events ALTER PRIMARY KEY (year, month DESC)
ALTER TABLE t ALTER PRIMARY KEY ()
```
