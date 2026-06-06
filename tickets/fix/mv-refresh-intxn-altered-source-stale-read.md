description: Inside an explicit transaction, reading a materialized-view *source* table via the prepared/suppressed scan path after an in-transaction `alter table … add column` returns the table's PRE-alter row shape (the new column's backfilled default is invisible / misaligned), even though the schema catalog and freshly-derived plans correctly reflect the new column. The same read with no MV present is correct. This makes `begin; alter table T add column …; refresh materialized view <select * over T>; commit` fill the MV backing with stale/misaligned data.
files: packages/quereus/src/runtime/emit/materialized-view-helpers.ts, packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/runtime/emit/alter-table.ts, packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus/src/core/database.ts
----

## Summary

Discovered while implementing `mv-refresh-rebuilds-backing-schema` (refresh now rebuilds
the backing schema when a `select *` body's shape shifts). The shape-aware refresh is
correct in **autocommit**, but in an **explicit transaction** the body re-execution reads
stale source data, so the rebuilt backing is filled with wrong values. The root cause is
**upstream of refresh** — a source-table read returning the pre-`alter` row shape
mid-transaction when a materialized view over that source exists.

This is **pre-existing** (the offending read goes through `collectBodyRows`, untouched by
the refresh ticket) and is **not** triggered by the normal autocommit usage. Filed as a
standalone fix so the shape-aware refresh isn't blamed for it.

## Reproduction (minimal)

```sql
create table customers (id integer primary key, name text not null);
create table orders (id integer primary key, customer_id integer not null
  references customers(id), amt integer not null);
create materialized view v as select * from orders o join customers c on o.customer_id = c.id;
insert into customers values (1,'alice');
insert into orders values (10,1,100);

begin;
alter table orders add column extra text default 'x';
-- The schema catalog is correct here: getTable('main','orders').columns = [id,customer_id,amt,extra]
-- and db.getPlan('select * from orders') derives 4 output columns.
-- BUT a raw/prepared scan of orders returns only the OLD 3-column rows:
refresh materialized view v;
commit;

select * from v;
-- WRONG: {id:10, customer_id:1, amt:100, extra:1, "id:1":1, name:"alice"}
--   (extra should be 'x'; the value 1 is c.id leaking in via column misalignment)
```

In **autocommit** (issuing the `alter` and `refresh` as separate statements, no explicit
`begin`/`commit`) the identical sequence is **correct** (`extra` = `'x'`).

## Empirical characterization (from throwaway probes)

- **Catalog is correct mid-txn**: `schemaManager.getTable('main','orders').columns` includes
  `extra`; `db.getPlan('select distinct * from orders').getRelations()[0].getType().columns`
  has 4 columns. So planning/schema resolution is fine.
- **Execution is stale**: a raw `db.prepare('select * from orders')._iterateRowsRaw()`
  (and `db.eval`, and `iterateRows`) mid-txn returns rows with only the **3 pre-alter
  columns** — the backfilled `extra` default is invisible.
- **MV-presence is the trigger**: the *same* mid-txn raw read with **no materialized view**
  over `orders` correctly returns 4 columns with `extra = 'x'`. Add the MV back and it
  reverts to 3 columns.
- Not a SQL-text statement cache: cache-busting the query (`… where 1=1`, `select distinct`)
  did not change the stale execution result.

This points at the data-layer read path for an MV **source** table mid-transaction: most
likely the source is read through a connection / transaction layer whose schema (or
`ALTER ADD COLUMN` overlay backfill) was captured before the in-txn alter — plausibly the
backing/source connection the MV row-time machinery registers and caches, or the memory
table's transaction-layer schema not picking up the in-txn `alterTable` migration when a
dependent structure holds a reference. (`alter-table.ts` `rebuildMemoryTable` /
`MemoryTableManager` schema-update + the MV manager's cached backing connections in
`database-materialized-views.ts` are the suspects.)

## Expected behavior

Inside an explicit transaction, a read of an MV source table after an in-transaction
`ALTER ADD COLUMN` must reflect the new column (with its backfilled default), exactly as it
does in autocommit and exactly as it does when no MV is present — so a same-transaction
`refresh materialized view` (and ordinary same-transaction reads / row-time maintenance)
operate on current source data.

## Scope notes

- Likely affects more than refresh: any same-transaction read or row-time maintenance of an
  MV source after an in-txn `ALTER ADD COLUMN` may see the stale shape. The fix should
  verify ordinary `begin; alter; insert into <source>; select from <mv>; commit` too, not
  just refresh.
- Repro is sharpest with a `select *` body (the new column is in the output) and a join MV,
  but the underlying source-read staleness is body-shape-independent.
- The `mv-refresh-rebuilds-backing-schema` in-place-`rebuildMemoryTable` fallback does **not**
  address this (it reuses the same `collectBodyRows` read), so don't reach for it here.
