description: StoreModule.alterTable() with eager row migration for ADD/DROP/RENAME COLUMN
files:
  - packages/quereus/src/index.ts (exported buildColumnIndexMap, columnDefToSchema)
  - packages/quereus-store/src/common/store-module.ts (StoreModule.alterTable(), buildColumnRemap())
  - packages/quereus-store/src/common/store-table.ts (StoreTable.migrateRows(), updateSchema())
  - packages/quereus-store/test/alter-table.spec.ts (14 tests)
----

## Summary

`StoreModule.alterTable()` implements `VirtualTableModule.alterTable` for store-backed tables:

- **ADD COLUMN**: Appends column to schema, migrates rows with null/DEFAULT via WriteBatch.
- **DROP COLUMN**: Removes column, reindexes PK/secondary index definitions, migrates rows.
- **RENAME COLUMN**: Schema-only (renames in columns + index references). No row migration.

All operations persist updated DDL to catalog and emit schema change events.

## Review findings

**Bug fixed**: `dropColumn` PK/index reindexing called `.map()` (adjust indices) before `.filter()` (remove dropped column), which corrupted the PK definition when a PK or index column appeared after the dropped column. Columns remapped to the dropped column's position were incorrectly filtered out. Fix: `.filter()` before `.map()`.

## Testing

14 tests in `packages/quereus-store/test/alter-table.spec.ts`:

- ADD COLUMN: null default, DEFAULT value, new inserts, empty table (4)
- DROP COLUMN: populated table, empty table, PK lookups after drop, PK preserved when dropping column before PK (4)
- RENAME COLUMN: data preserved, new inserts with new name (2)
- Sequential: add+rename+drop, multiple adds, add then drop same column (3)
- DDL persistence: loadAllDDL reflects ADD COLUMN (1)
