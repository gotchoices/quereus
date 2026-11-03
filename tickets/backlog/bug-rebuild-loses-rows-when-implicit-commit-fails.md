description: On a storage backend that cannot change a primary key in place, a plain primary-key change whose final commit fails leaves the table empty, because the table swap survives the failure while the copied rows do not.
architecture: docs/module-authoring-schema-changes.md
files:
  - packages/quereus/src/runtime/emit/alter-table.ts   # rebuildViaShadowTable: the row copy, and the comment explaining the two halves' different lifetimes
  - packages/quereus/test/no-alter-module.ts   # stub backend that forces the rebuild path
repro: verified
severity: corruption
likelihood: contrived
tradeoffs: Only third-party backends with no in-place re-key reach this, and the one shape seen needs rows that already break a deferred foreign key, so a maintainer may wait for a real backend to need it; but the loss is of committed rows.

# A rebuilt primary key loses its rows when the implicit commit fails

A backend that cannot re-key in place changes a primary key by building a hidden copy of the table, copying the rows, dropping the original and renaming the copy over it. The drop and rename survive a rollback and the row copy does not. The engine refuses this inside an explicit transaction, and `bug-apply-schema-loses-rows-after-rebuild-when-later-step-fails` refuses it in an `apply schema` that does anything else. A lone `ALTER PRIMARY KEY` in autocommit stays allowed, on the assumption that nothing can fail after the rebuild finishes. Its implicit commit still can.

## Reproduction

Using `makeNoAlterModule({ withRenameTable: true })` as the default module:

```sql
create table p (id integer primary key);
create table t (a integer not null, c integer not null, f integer null, primary key (a),
	constraint fk foreign key (f) references p(id) deferrable initially deferred);
pragma foreign_keys = off;
insert into t values (1, 10, 99);
pragma foreign_keys = on;
alter table t alter primary key (c);   -- fails: CHECK constraint failed: fk
select * from t;                       -- no rows
```

Observed: the error and the empty table. Inferred, not traced: the failure comes from the commit. The rows being gone means the failure came after the drop, and a deferred constraint is checked at commit. Not tried: a module whose own commit throws, which should end the same way.

## Expected behavior

A failed re-key keeps the table's rows. A re-key changes no row, so a violation that was already there should not be able to fail it. A commit that fails for any other reason must not lose the rows either, or must say that it did.

Refusing is not available here, because this is the one rebuild shape the engine still allows.
