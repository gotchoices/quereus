description: A schema declaration that removes a table and also adds a new foreign key pointing at that table deletes the table and its rows first, then fails, leaving the schema half-migrated instead of being refused before anything changes.
architecture: docs/schema-declarative.md#migration-order
files:
  - packages/quereus/src/schema/schema-differ.ts # generateMigrationPlan: DROP TABLE in the drops phase, ADD CONSTRAINT in stage 3 of pushTableAlters
  - packages/quereus/src/runtime/emit/schema-declarative.ts # the apply loop, where a pre-check could refuse before the first step
repro: verified
severity: edge-case
likelihood: contrived
tradeoffs: The declaration is self-contradictory (a foreign key to a table it removes), the table it loses is one the user asked to remove, and the failure is reported as a partial migration, so a maintainer may judge a pre-check not worth its code.
----

Run on the memory module:

```sql
pragma foreign_keys = true;
create table T (Id integer primary key); insert into T values (1);
create table P (Id integer primary key, R integer); insert into P values (1, 1);
declare schema main { table P { Id integer primary key, R integer, constraint pf foreign key (R) references T(Id) } }
apply schema main;
```

Plan: `DROP TABLE IF EXISTS t ; ALTER TABLE P ADD constraint pf foreign key (R) references T(Id)`. The `DROP TABLE` runs (nothing references `T` yet), then the `ADD CONSTRAINT` fails with `FOREIGN KEY constraint failed: P (R) has rows referencing a missing 'T'`. Because `DROP TABLE` cannot be undone, the apply reports the schema as partially migrated.

Found while working `bug-apply-schema-refuses-parent-removed-with-its-foreign-key`, whose fix (running `DROP CONSTRAINT` before `DROP TABLE`) does not change this case.

## Expected behavior

With foreign keys enforced, the apply is refused before its first step when a foreign key the plan adds names a table the plan removes and does not recreate, and the child has rows whose foreign-key columns are all non-null (the rows `ADD CONSTRAINT` would reject). Nothing changes. With no such rows, or with foreign keys off, the apply behaves as today (it ends with a foreign key naming a missing table, as the same statements run by hand do).

## Note from the constraint-drop reorder

`computeSchemaDiff` now sets `SchemaDiff.removalsStillReferenced` when a declared foreign key names a table the plan removes for good (or a declared CHECK, DEFAULT or generated expression may reach a removed table or view). A pre-check for this case can start from that flag rather than walking the declaration again. With the flag set, the plan keeps its `DROP CONSTRAINT` steps in stage 2 of the table alters, after `DROP TABLE`, so a foreign key the declaration changes but still points at the removed table refuses the drop with the rows intact; only a foreign key that is new in the declaration still reaches this bug.
