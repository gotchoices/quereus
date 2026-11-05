description: A CHECK with a subquery that compares a table's column to a same-named column of another table, such as `exists (select 1 from v where v.b = t.b)`, is accepted when the table is created and then makes every write fail. This is a natural way to write such a rule, and it should work.
prereq: bug-self-qualified-check-reads-context-variable
architecture: docs/sql-ddl.md
files:
  - packages/quereus/src/schema/rename/self-qualifier-strip.ts  # stripColumnQualifier: the capture loop leaves the qualifier in place
  - packages/quereus/src/planner/building/constraint-builder.ts  # buildConstraintChecks: the scope has no <table>.<column> names
repro: verified
severity: edge-case
likelihood: normal-use
tradeoffs: The failure is a clear error at the first write, and `new.b` is a working spelling today, so a maintainer might only document it.
----

To read a CHECK's own row, enforcement folds `t.b` to the bare `b`. Inside a subquery whose source also has a column `b`, the bare name would bind to that source, so the strip leaves `t.b` qualified, and nothing resolves it.

Measured on the `dist` build, memory module:

```sql
create table v (b integer primary key);
insert into v values (1);
create table t (a integer primary key, b integer null, check (exists (select 1 from v where v.b = t.b)));
insert into t values (1, 1);   -- fails: t.b isn't a column
```

The same CHECK spelled `new.b` works, and with a source that has no column `b` the spelling `t.b` works too.

## Expected behavior

A self-qualified name in a CHECK reaches the row's column wherever it appears, unless an inner FROM rebinds the qualifier.

`bug-self-qualified-check-reads-context-variable` introduces a reserved qualifier for this, used only for a column that shares its name with a context variable, which cannot be captured by a subquery's source. Using it for every self-qualified name in a CHECK would close this bug, and might remove the catalog lookup from the strip. Generated columns share the strip and are likely to behave the same way, which was not measured.
