description: A generated column added with ALTER TABLE ADD COLUMN stops being computed once any column of the table is renamed: every row written afterwards stores NULL in it, silently. Columns declared in CREATE TABLE are not affected.
architecture: docs/sql-alter.md
files:
  - packages/quereus/src/runtime/emit/alter-table.ts  # runRenameColumn (~line 357): stores the module-returned schema via schema.addTable with no withGeneratedColumnGraph; the ADD COLUMN arm (~line 1335) applies it only to the catalog copy
  - packages/quereus/src/schema/table.ts  # withGeneratedColumnGraph (~line 1615)
  - packages/quereus/src/vtab/memory/layer/manager.ts  # addColumn (~1892) / renameColumn (~2123): the module's own copy of the table schema
repro: verified
----
## Observed

Found during the review of `check-self-qualifier-beside-same-named-subquery-column`; it reproduces identically on the build from before that change, so it is not caused by it.

```sql
create table sq (id integer primary key, a integer);
insert into sq values (1, 5);
alter table sq add column d integer null generated always as (a + 100);
alter table sq rename column a to aa;
insert into sq (id, aa) values (3, 1);
select * from sq;
-- [{"id":1,"aa":5,"d":105},{"id":3,"aa":1,"d":null}]   expected d = 101 for id 3
```

Measured variations (memory module, scratch script against `src`):

- Renaming an unrelated column (`rename column id to pk`) has the same effect.
- `stored` instead of `virtual`: same effect.
- `ADD COLUMN e integer null` instead of the rename: no effect, `d` is computed.
- The same generated column declared in `CREATE TABLE`, then the rename: `d` is computed correctly.
- A plain `default 7` column added then a rename: correct.
- The stored schema SQL after the rename shows the generated body correctly rewritten (`aa + 100`), so the expression itself is fine.
- When the generated column is declared NOT NULL (the default), the insert fails with `NOT NULL constraint failed: sq.d` instead of storing NULL.

## Suspected cause (static, not confirmed)

`runRenameColumn` takes the table schema the module's `alterTable({ type: 'renameColumn' })` returns and stores it with `schema.addTable` without recomputing `generatedColumnDependencies` / `generatedColumnTopoOrder` (`withGeneratedColumnGraph`). The ADD COLUMN arm applies `withGeneratedColumnGraph` to the schema it stores in the catalog, but the module's own copy may never receive the graph, so the schema the rename returns has no evaluation order for the added column and the write path computes nothing for it. A CREATE TABLE column is in the module's copy from the start, which would explain why it survives. To confirm: inspect `generatedColumnTopoOrder` on the catalog schema after the rename in the repro above.

## Expected

After any ALTER, every generated column is computed on every write, whether it was declared at CREATE TABLE or added later. Consider whether the invariant belongs at `schema.addTable` (or one shared "store an altered table schema" step) rather than in each ALTER arm, so a new ALTER arm cannot drop the graph again.
