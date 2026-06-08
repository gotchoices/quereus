description: foreign_key_info(table_name) TVF — exposes FK constraint metadata
prereq: none
files:
  - packages/quereus/src/func/builtins/schema.ts (foreignKeyInfoFunc, lines 194-268)
  - packages/quereus/src/func/builtins/index.ts (registration at line 24, 152)
  - packages/quereus/test/logic/06.3.2-schema-foreign-keys.sqllogic
  - docs/functions.md (Schema Introspection TVFs section)
----

## What was built

`foreign_key_info(table_name)` table-valued function returning foreign key constraint metadata for a given table. 11 output columns: `id`, `name`, `table`, `from`, `referenced_table`, `referenced_schema`, `to`, `on_update`, `on_delete`, `deferred`, `seq`.

## Review notes

- Implementation is clean: uses `createIntegratedTableValuedFunction`, validates input, iterates FKs and their columns with proper composite FK support (same `id`, different `seq`).
- Parent column resolution uses `referencedColumnNames` (always populated by schema manager) with fallback to `_findTable` index lookup. The fallback doesn't pass `referencedSchema`, but this is harmless since `referencedColumnNames` is always set for SQL-created tables.
- Column type definitions correctly mark nullable columns (`name`, `referenced_schema`).
- Docs in `functions.md` are complete with column table and usage example.
- Build and all tests pass.

## Test coverage

8 test cases in `06.3.2-schema-foreign-keys.sqllogic`:
- Basic single-column FK (all columns verified)
- Table with no FKs (empty result)
- Named constraint (`name` column populated)
- ON DELETE/UPDATE actions (cascade, restrict)
- Multiple FKs on one table (distinct `id` values)
- Composite FK (same `id`, seq 0 and 1)
- Auto-generated constraint name
- Nonexistent table (error)

## Usage

```sql
select "from", "to", on_delete from foreign_key_info('orders');
select * from foreign_key_info('child_table') where on_delete = 'cascade';
```
