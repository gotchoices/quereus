description: Renaming a column or table can silently change a CHECK that reads a per-statement context value, so it reads a column instead, or the reverse, and dropping or renaming an unrelated table named `context` can wrongly be refused or break that CHECK. The rule then enforces something different from what was declared, or fails on every write.
architecture: docs/sql-ddl.md#262-mutation-context-table-level-parameters
files:
  - packages/quereus/src/schema/rename/column-rename.ts  # renameColumnInCheckExpression, columnReferencedInCheckExpression, renameColumnInColumnExpressions: own-table seeded walk
  - packages/quereus/src/schema/rename/table-rename.ts  # walkTableRefs and TableRenameOpts: `context.<name>` counts as a reference to a table named `context`
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

Expected: renaming leaves a bare reference to a declared variable alone and rewrites `new.who` and `t.who`; a drop is refused only by a reference that reaches the column. `bug-self-qualified-check-reads-context-variable` makes `t.who` reach the column, so rewriting it to `t.w` and refusing its drop are both correct once that lands, and the `check (t.who > 0)` case below stops being a wrong rewrite. Only rows stored under the former meaning can still be affected. The bare-name rule also applies to a column DEFAULT, which shares this walker through `renameColumnInColumnExpressions` and was not measured. A generated column's bare name always means the column (`docs/sql-ddl.md`), so that case must stay as it is.

## Further measurements

Measured during the review of `bug-check-facts-read-context-variable-as-column`, on the `dist` build, memory module. These confirm the DEFAULT case above and add two more.

**The rename brings back that ticket's wrong result.** The optimizer no longer draws a column fact from a CHECK that reads a variable, but the rewritten CHECK reads the column, so the fact returns and covers rows stored under the old meaning:

```sql
create table t (a integer primary key, who integer null, check (who > 0)) with context (who integer null);
insert into t values (1, -1);
alter table t rename column who to w;
select * from t;                  -- [{"a":1,"w":-1}]
select * from t where w <= 0;     -- [] (wrong: should return the row)
```

`check (t.who > 0)` does the same, and its rewritten form is `t.w > 0`. `check (context.who > 0)` is left alone and returns the row correctly.

**A DEFAULT breaks outright.** With `b integer null default (who)`, the same rename stores `default w`, and the next `insert into t (a) with context who = 7 values (1)` fails with `Column not found: w`.

**Renaming a column to a variable's name has the opposite effect.** With `check (x > 0)` and a variable `who`, `alter table t rename column x to who` is accepted and the stored CHECK becomes `who > 0`, which now reads the variable. `insert into t values (2, -1)` is then accepted, so the column is no longer constrained. The optimizer draws no fact here, so queries stay correct. A `new.x` in a DEFAULT becomes `new.who` and keeps working.

Expected for this last case is not stated above: the rename must keep the CHECK reading the column, for instance by refusing the rename or by rewriting to `new.who`.

## The `context.<name>` spelling reaches the same walkers

Measured during the review of `bug-self-qualified-check-reads-context-variable`, on the `dist` build, memory module. The rename and dependency walkers treat `context.<name>` in a CHECK as a reference to a table named `context`, although §2.6.2 says it reaches the variable.

A separate table named `context`, with `create table items (a integer primary key, check (context.x > 0)) with context (x integer null)`:

| Statement on the table `context` | Today | Expected |
|---|---|---|
| `drop table context` | refused: `referenced by the CHECK constraint (context.x > 0) on table 'items'` | succeeds |
| `alter table context rename to foo` | `items` stores `foo.x > 0`, and every write to it fails: `foo.x isn't a column` | `items` unchanged |
| `alter table context rename column x to y` | `items` stores `context.y > 0`, and every write to it fails: `context.y isn't a column` | `items` unchanged |

A table itself named `context`, with a column and a variable both named `who`. The two table renames became silent meaning changes with `bug-self-qualified-check-reads-context-variable`, because `t.who` now reads the column while `context.who` reads the variable. That timing is reasoned from that ticket's measurements; the old build was not run:

| Statement | Today | Expected |
|---|---|---|
| `check (t.who > 0)`, `alter table t rename to context` | stores `context.who > 0`, so the CHECK silently moves to the variable | keeps reading the column, for instance as `main.context.who` |
| `check (context.who > 0)`, `alter table context rename to foo` | stores `foo.who > 0`, so the CHECK silently moves to the column | keeps reading the variable, `context.who` |
| `check (context.who > 0)`, `alter table context rename column who to whom` | stores `context.whom > 0`, so the CHECK silently moves to the column | `context.who` unchanged |
| `check (context.who > 0)`, `alter table context drop column who` | refused | allowed: the CHECK reads the variable |

`TableRenameOpts.rowImageContext` already stops these walkers from counting `new.` and `old.` as table references, so a CHECK on a table declaring context needs the same treatment for `context.<declared name>`.
