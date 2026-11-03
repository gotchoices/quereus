description: On a storage backend that cannot change a primary key in place, an "apply schema" that changes a primary key and then fails on a later step leaves the table empty, while reporting an ordinary failure with the schema restored.
architecture: docs/schema-undo-plan.md#restoring-a-failed-apply
files:
  - packages/quereus/src/runtime/emit/alter-table.ts   # rebuildViaShadowTable; the explicit-transaction refusal that names this same trap
  - packages/quereus/src/runtime/emit/schema-declarative.ts   # the apply loop and its unwind
  - packages/quereus/test/no-alter-module.ts   # the stub backend that forces the rebuild path
repro: verified
severity: corruption
likelihood: unusual
tradeoffs: Only third-party backends with no in-place re-key reach this, since the memory backend keeps its rows in the same scenario and the store backend also re-keys in place, so a maintainer may wait for a real backend to need it; but the loss is silent and of committed rows.

# Committed rows are lost when a rebuilt primary key's apply fails

A backend that cannot re-key in place changes a primary key by building a hidden copy of the table, copying the rows across, dropping the original and renaming the copy over it. `ALTER PRIMARY KEY` on such a backend is already refused inside an explicit transaction, with this explanation: the drop and rename survive a rollback while the row copy does not, so a rollback leaves an empty table.

`apply schema` reaches the same trap without an explicit transaction. Its steps run in one implicit transaction, so a step that fails after the rebuild rolls back the copied rows. The catalog is unwound and matches its pre-apply rendering, which cannot see rows, so the caller gets the failing step's error and no hint of the loss.

## Reproduction

Using `makeNoAlterModule({ withRenameTable: true })` as the default module:

```sql
create table t (a integer not null, c integer not null, b integer null, primary key (a));
insert into t values (1, 10, 1), (2, 20, 1);
declare schema main {
	table t { a integer not null, c integer not null, b integer null, primary key (c), constraint ub unique (b) }
}
apply schema main;       -- fails on the ADD CONSTRAINT step, reports no partial migration
select * from t;         -- no rows
```

The same `alter table t alter primary key (c)` in autocommit keeps its rows, and so does the same apply when it has no failing step. On the memory backend this scenario fails the same way and keeps both rows. The failure does not depend on the undo guards: this shape has no assertion, CHECK or foreign key for them to refuse.

## Expected behavior

A failed apply either keeps the table's rows or says it did not. Refusing up front is acceptable, as the explicit-transaction case does: a plan that needs a rebuild and has any other step cannot be taken back on such a backend.

## Gardener note (2026-11-02)

Promoted because this is a silent loss of committed rows that reports the schema as restored. The ticket's expected behaviour settles the design unless research finds better: refuse up front, as the explicit-transaction case does, when a plan needs a rebuild and has any other step. Keep the single-statement rebuild working.
