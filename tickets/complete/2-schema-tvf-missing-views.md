description: schema() TVF now includes views in its output
status: complete
----

# schema() TVF - Views Support

## What was built

Added view iteration in `schema()` TVF (`packages/quereus/src/func/builtins/schema.ts:98-106`) that calls `schemaInstance.getAllViews()` and yields rows with `type = 'view'`, the view name, and the original SQL.

## Key files

- `packages/quereus/src/func/builtins/schema.ts` - view loop added after table/index loop
- `packages/quereus/test/logic/06.3-schema.sqllogic` - sqllogic tests for view output

## Testing

- Views appear in `schema()` output with `type = 'view'`
- View SQL is correctly preserved
- `SELECT DISTINCT type FROM schema()` includes `'view'`
- All 751 tests pass

## Usage

```sql
create view my_view as select id, name from my_table where active = 1;
select * from schema() where type = 'view';
-- Returns: type='view', name='my_view', tbl_name='my_view', sql='create view ...'
```
