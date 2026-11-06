description: With foreign keys enforced, a schema migration that removes a table and, in the same declaration, also removes the foreign key another table uses to point at it is refused when the child table has rows, even though the result would be valid, because the migration drops the parent table before it removes the foreign key.
architecture: docs/schema-declarative.md#migration-order
files:
  - packages/quereus/src/schema/schema-differ.ts # generateMigrationPlan: DROP TABLE runs in the drops phase, DROP CONSTRAINT in stage 2 of pushTableAlters
  - packages/quereus/src/schema/manager.ts # assertNoReferencingChildrenForDrop ~1554, the refusal
repro: verified
severity: edge-case
likelihood: unusual
tradeoffs: The apply fails on its first step with a clear error and nothing is lost, and splitting it into two applies (first drop the foreign key, then the table) works, so a maintainer may not want to reorder the plan for it.
----

Found while working `bug-apply-schema-refuses-view-removed-with-its-check`, which is the same pattern for CHECK and DEFAULT rules (a drop judged against the half-migrated schema rather than the declared result). That ticket's fix is in the expression guard and does not cover this one, which is refused by the foreign-key check on `DROP TABLE`.

Run on the memory module:

```sql
pragma foreign_keys = true;
create table T (Id integer primary key); insert into T values (1);
create table P (Id integer primary key, R integer, constraint pf foreign key (R) references T(Id));
insert into P values (1, 1);
declare schema main { table P { Id integer primary key, R integer } }
apply schema main;
```

Plan: `DROP TABLE IF EXISTS t ; ALTER TABLE P DROP CONSTRAINT pf`. Result: `FOREIGN KEY constraint failed: cannot drop table 't' because table 'P' still has rows referencing it`, followed by the note that the failing `DROP TABLE` step cannot be undone (the refusal happened before anything changed, so no rows were in fact lost).

## Expected behavior

The declaration applies: once the plan has finished, no foreign key points at the removed table. A declaration that removes the parent and keeps the child's foreign key must still be refused, before any rows of the parent are dropped.

## Notes

A likely fix is ordering: run `DROP CONSTRAINT` for a foreign key whose parent this plan removes ahead of the table drops, as a user would by hand, which also keeps `diff schema` output runnable as written. Not tried. Whatever the fix, it must not let the parent drop through when a declared foreign key (a kept one or a newly added one) still names the removed table, because `DROP TABLE` destroys rows and cannot be undone.

The failure message also says the failing step "cannot be undone … so any partial effect of it stands", although a refused drop changed nothing; that wording is shared with every refused irreversible step and is not specific to this case.
