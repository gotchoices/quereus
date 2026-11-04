description: A schema declaration that adds a column to a table and also adds a view reading that column can never be applied, because the migration creates the view before the column exists.
architecture: docs/schema.md#migration-order
files:
  - packages/quereus/src/schema/schema-differ.ts   # generateMigrationPlan, pushCreates(diff.viewsToCreate, 'view') ~3172, ahead of the alter block
  - docs/schema.md   # Migration Order
repro: verified
severity: edge-case
likelihood: normal-use
tradeoffs: The failure is clean and restored, and applying the column first and the view second works, so a maintainer may defer this; moving view creates also has to preserve their column-rename reconciliation.
----

# Apply schema creates views before the columns they read

Over an applied `table t { id integer primary key, b integer null }`, this declaration fails:

```sql
declare schema main {
	table t { id integer primary key, b integer null, d integer null }
	view v as select d from t
}
apply schema main;
```

```
Failed to execute DDL: create view v as select d from t
Error: Column not found: d
```

The run that produced this (memory, HEAD c78d2229a) also declared a table constraint that would have failed later, but the view step failed first and comes from plan order alone. The catalog was restored, so nothing is damaged. The declaration is valid and describes a reachable end state, and the plan cannot reach it in one apply.

`apply-schema-creates-indexes-before-added-columns` fixed the same ordering problem for indexes and deliberately left views in place ("views keep their column-rename reconciliation").

Expected: the declaration applies and `select d from v` works.

Moving view creates after the table alters must not break the reverse dependency. An added column's DEFAULT can read a view the same plan creates (`create view w …`, then `ADD COLUMN z … default (select m from w)`). This applies today and is pinned by `applies a DEFAULT reading a view the same plan creates` in `packages/quereus/test/apply-schema-alter-order.spec.ts`. The alters now run in stages across tables (`pushTableAlters`), and Migration Order now lives in `docs/schema-declarative.md`.
