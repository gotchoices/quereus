description: A materialized view built on an ordinary view keeps computing from that view's old definition after the view is redefined or dropped, so it silently holds values its own query would no longer return.
architecture: docs/mv-schema-change.md
files:
  - packages/quereus/src/core/database-materialized-views.ts # subscribeToSchemaChanges handles table_* and materialized_view_removed, not view_removed / view_added
  - packages/quereus/src/runtime/emit/drop-view.ts # fires view_removed, which no maintained-table code listens to
  - packages/quereus/src/schema/schema-differ.ts # computeSchemaDiff leaves an unchanged maintained table alone when a view it reads is recreated
repro: verified
severity: wrong-result
likelihood: unusual
tradeoffs: A maintainer could defer this because it needs a view underneath a materialized view and then a change to that view, and could choose between marking the table stale and re-deriving it, which changes what later queries of it do.
----

Found while working on `bug-apply-schema-redefine-view-a-rule-reads`. Run on the current code with a temporary spec, on the memory module, using only plain DDL, so `apply schema` is not needed to reach it.

```sql
create table T (Id integer primary key, N integer);
insert into T values (1, 10);
create view V1 as select sum(N) as S from T;
create materialized view M as select S from V1;

drop view V1;
create view V1 as select sum(N) + 1 as S from T;
```

| after | `select S from M` | what `M`'s body now returns |
|---|---|---|
| the redefinition | 10 | 11 |
| `insert into T values (2, 1)` | 11, so maintenance still runs the old body | 12 |
| `drop view V1`, then `insert into T values (3, 1)` | 12, with the view `M` reads gone | the body no longer plans |

## Expected behavior

A change to a view a materialized view reads is handled as a change to one of its source tables is ([Materialized view schema changes](../../docs/mv-schema-change.md)): the table stops presenting rows its body would not produce, either by being marked stale or by being re-derived.

`apply schema` has the same result. Declaring `V1` with a new body and `M` unchanged plans only `DROP VIEW` and `CREATE VIEW`, and `M` keeps its old rows and old maintenance plan.

## Notes

The row-time plan inlines the view's body when the materialized view is attached. The listener in `subscribeToSchemaChanges` reacts to table events only, and a view's drop and create fire `view_removed` and `view_added`.

A CHECK that reads such a materialized view is judged against its stale rows by the re-validation `apply schema` runs after recreating a view, so fixing this would also make that check more accurate.
