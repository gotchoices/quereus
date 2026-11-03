description: When "apply schema" adds a column and also creates a new table that points at that column, a later failure leaves the database half-migrated, because the automatic rollback tries to remove the column while the new table still refers to it.
architecture: docs/schema-undo-plan.md
files:
  - packages/quereus/src/schema/schema-differ.ts   # generateMigrationPlan phase order (table creates ~3171, alters ~3191); UndoRenderer.dropAddedColumn
  - packages/quereus/src/runtime/emit/schema-declarative.ts   # runBatchedMigrationLoop, the reverse-order unwind
  - packages/quereus/src/runtime/emit/drop-column-guards.ts   # the guards that refuse the undo
repro: verified
----

# Undo of ADD COLUMN is refused while a table the same plan created still refers to the column

The migration plan creates new tables before it alters existing ones, and the undo journal runs in exact reverse. So when a new table refers to a column the same plan adds, the undo of `ADD COLUMN` runs before the undo of `CREATE TABLE`, while the reference still exists, and `DROP COLUMN` refuses.

The forward order works because `CREATE TABLE` does not require the referenced column to exist yet. The reverse order fails for the same two steps.

## Repro (memory, HEAD c78d2229a)

Start from `table t { id integer primary key, b integer null }` applied, with rows `(1, 1), (2, 1)`. The failing step in both cases is `ADD constraint ub unique (b)`.

New table with a foreign key to the added column:

```sql
declare schema main {
	table t { id integer primary key, b integer null, d integer null unique, constraint ub unique (b) }
	table n { id integer primary key, x integer null references t(d) }
}
apply schema main;
```

```
The schema is partially migrated and could not be restored: undo statement `ALTER TABLE t DROP COLUMN d` failed (Cannot drop column 'd' from 't': it is referenced by foreign key '_fk_n_x' on table 'n').
```

New table with a CHECK whose subquery reads the added column, `x integer null check (x > (select max(d) from t))`:

```
… undo statement `ALTER TABLE t DROP COLUMN d` failed (Cannot drop column 'd' from 't': it is referenced by CHECK constraint '_check_x' on table 'n').
```

## Expected

The failed apply restores the pre-apply schema and reports only the original error, as `docs/schema-undo-plan.md` and `docs/schema.md` § Failure and restoration promise for a plan with no data-destroying step.

## Not yet checked

The same shape may exist between two altered tables: `u` altered ahead of `t`, with `ADD constraint … references t(d)` on `u` and `ADD COLUMN d` on `t`. Not run. Settle it while reproducing, since reverse order has the same problem if the forward step is accepted.

This is separate from `bug-apply-undo-of-add-column-with-inline-constraint-fails`, where the column's own CHECK blocks the undo and can be dropped in the same step.
