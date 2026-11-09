description: A schema declaration that adds a new materialized view reading a column added or renamed in the same apply, or reading a new plain view, can never be applied, because the migration creates the materialized view too early.
prereq: bug-apply-schema-creates-views-before-added-columns
architecture: docs/schema-declarative.md#migration-order
files:
  - packages/quereus/src/schema/schema-differ.ts   # generateMigrationPlan: a new materialized view rides diff.tablesToCreate, pushed ahead of views and table alters
  - docs/schema-declarative.md   # Migration Order
  - docs/schema-rename-detection.md   # "Residual hazard" sentence, materialized-view half
repro: verified
severity: edge-case
likelihood: normal-use
tradeoffs: The failure is clean and restored and two applies work around it, and moving these creates changes when a materialized view fills with rows relative to the table changes, so a maintainer may defer it.
----

# Apply schema creates a new materialized view before what it reads

Each of these fails on the memory module, using the engine built in `packages/quereus/dist` shortly before HEAD `40d481759`, over an applied `table t { id integer primary key, b integer null }`, and the catalog is restored:

```sql
-- reads a column added in the same apply
table t { id integer primary key, b integer null, d integer null }
materialized view m as select id, d from t
-- Failed to execute DDL: create materialized view m as select id, d from t
-- Column not found: d

-- reads a column renamed in the same apply
table t { id integer primary key, b2 integer null with tags ("quereus.previous_name" = 'b') }
materialized view m as select id, b2 from t
-- Column not found: b2

-- reads a new plain view
table t { id integer primary key, b integer null }
view w as select id, b from t
materialized view m as select id, b from w
-- Table 'w' not found in schema path: main
```

## Expected behaviour

All three apply, and a re-diff is empty.

A new materialized view is rendered from `diff.tablesToCreate`, so it runs with the plain table creates, ahead of view creates and table alters. An existing table that becomes maintained does not have this problem: its `set maintained as` already runs after the alters.

`bug-apply-schema-creates-views-before-added-columns` sorts plain view creates into the table-alter stages. A materialized view create could join the same sort, but things that read it must still come after it: a plain view's body, an added column's DEFAULT, and a foreign key. `apply-schema-creates-referenced-tables-first` also reorders this bucket and explicitly leaves materialized views out.

## A maintained table written before its source

A related form fails for a simpler reason. A `table … maintained as` create stays at its written position in the create list, unlike the `materialized view` form, which always follows every declared table. Written ahead of a new source, it fails on the memory module, though the other written order applies:

```sql
table mt { id integer primary key } maintained as select id from c;
table c { id integer primary key }
-- Failed to execute DDL: create table mt (id integer primary key) maintained as select id from c
-- Table 'c' not found in schema path: main
```

`apply-schema-creates-referenced-tables-first` makes a maintained create follow every create written before it, so that it does not move ahead of its source. A fix here should replace those edges with the tables the body actually reads.
