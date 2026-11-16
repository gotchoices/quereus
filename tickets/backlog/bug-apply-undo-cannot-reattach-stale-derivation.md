description: When a maintained table's source has been dropped, its definition is marked stale; if an "apply schema" then detaches it and fails later, the rollback cannot put the definition back and the database is left half-migrated.
architecture: docs/schema-undo-plan.md#guards-during-an-unwind
files: packages/quereus/src/schema/schema-differ.ts, packages/quereus/src/runtime/emit/materialized-view-helpers.ts, packages/quereus/src/runtime/emit/schema-declarative.ts
repro: verified
severity: edge-case
likelihood: unusual
tradeoffs: The fix needs a way for the undo to record a derivation as stale without deriving rows from it, which ordinary DDL cannot express, for a state (a maintained table already reporting itself broken) that most users fix by dropping the derivation anyway.
----

# A stale derivation cannot be re-attached by an unwind

A maintained table whose source is dropped, or loses a column its body reads, keeps its derivation but marks it stale. Reads then fail with *materialized view 'm' is stale; a source changed in an incompatible way*. That state is reachable with ordinary statements (`drop table src`, `alter table src drop column x`, `drop view` of a view the body reads).

If a declaration then lists the table as plain, the plan detaches it (`ALTER TABLE m DROP MAINTAINED`). When a later step fails, the undo is `alter table m set maintained as <pre-apply body>` (`UndoRenderer.setMaintainedFrom` in `schema-differ.ts`). The re-attach derives the rows from the body, so it has to compile it, and the body no longer compiles. The undo fails and the apply reports *The schema is partially migrated and could not be restored*.

## Reproduction (memory backend, verified)

```sql
create table t (id integer primary key, b integer null);
insert into t values (1, 1), (2, 1);
create table src (id integer primary key, x integer null);
insert into src values (1, 5);
create table m (id integer primary key, x integer null);
alter table m set maintained as select id, x from src;
drop table src;
declare schema main {
	table t { id integer primary key, b integer null, constraint ub unique (b) }
	table m { id integer primary key, x integer null }
}
apply schema main;
```

The plan is `ALTER TABLE m DROP MAINTAINED`, then `ALTER TABLE t ADD constraint ub unique (b)`, which fails on the duplicate `b`. The error ends with: undo statement `alter table m set maintained as select id, x from src` failed (Table 'src' not found in schema path: main).

## Expected

The unwind returns `m` to what it was: maintained, with the same body, still stale, holding the same rows. The step's own error (`ub`) is reported.

## Notes

- The other undo-time judgements of a re-attach already stand down (`bug-apply-undo-refused-when-recreated-object-does-not-validate`): the declared CHECK / foreign key scan and the full-rebuild size limit. The body compile and the row derivation cannot, because the re-attach writes the rows it derives.
- A `NOTE:` at `setMaintainedFrom` marks the site.
- Whether the restore check (`renderCatalogForRestoreCheck`) sees the stale flag was not checked; a restore that re-attaches as live would differ from the pre-apply state in that flag.
