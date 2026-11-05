description: Renaming a column that shares its name with a per-statement context value silently changes any CHECK reading that value so it reads the renamed column instead, and dropping such a column is wrongly refused. The rule then enforces something different from what was declared, without any error.
architecture: docs/sql-ddl.md#262-mutation-context-table-level-parameters
files:
  - packages/quereus/src/schema/rename/column-rename.ts  # renameColumnInCheckExpression, columnReferencedInCheckExpression, renameColumnInColumnExpressions: own-table seeded walk
  - packages/quereus/src/runtime/emit/alter-table.ts  # rewriteTableForColumnRename
  - packages/quereus/src/runtime/emit/drop-column-guards.ts  # assertNoCheckConstraintNamesColumn
repro: verified
severity: wrong-result
likelihood: unusual
tradeoffs: It needs a column and a context variable with the same name, which is uncommon, and the column-rename rewriters are exported for persisting modules to call, so a fix probably changes a public signature.
----

§2.6.2 of `docs/sql-ddl.md` says a bare name in a CHECK or DEFAULT means the context variable when a table declares both, and `new.<name>` reaches the column. The column-rename walker treats a bare name as the table's own column regardless.

Measured on the `dist` build of the current tree, memory module:

```sql
create table t (a integer primary key, who integer null, constraint k check (who > 0))
  with context (who integer null);
alter table t rename column who to w;
-- check_constraint_info('t') now reports the expression as: w > 0
insert into t with context who = -5 values (1, 9);   -- accepted, though the declared rule read who = -5
insert into t with context who = 5 values (2, -9);   -- rejected: CHECK constraint failed: k (w > 0)
```

Dropping the column fails the same way, for the same cause: `alter table t drop column who` is refused with `it is referenced by CHECK constraint 'k'`, although the CHECK reads the variable and only a `new.who` reference would need the column.

Expected: renaming leaves a bare reference to a declared variable alone and rewrites `new.who`; a drop is refused only by a reference that reaches the column. The bare-name rule also applies to a column DEFAULT, which shares this walker through `renameColumnInColumnExpressions` and was not measured. A generated column's bare name always means the column (`docs/sql-ddl.md`), so that case must stay as it is.
