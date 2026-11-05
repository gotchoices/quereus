description: Writing through a view fails with a "column not found" error when the view's filter uses a WITH query that reads the row being filtered, even though reading the same view works and the same filter written as a plain subquery can be written through.
architecture: docs/view-updateability.md
files:
  - packages/quereus/src/planner/mutation/scope-transform.ts  # cloneWithClause ~line 319, plus the same claim in the comments at ~lines 170 and 244
repro: verified
severity: edge-case
likelihood: unusual
tradeoffs: The statement is rejected with an error and writes nothing, the shape is rare, and rejecting it with a clearer message may be enough instead of rewriting WITH bodies during lowering.
----

## What happens

```sql
create table u (id integer primary key);
insert into u values (1);
create table b (id integer primary key, x integer);
insert into b values (1, 5), (2, -5);

-- Filter through a WITH query
create view v2 as select id, x from b where (with c as (select b.x as y from u) select max(y) from c) > 0;
select id, x from v2;        -- works, returns row 1
update v2 set x = 100;       -- error: b.x isn't a column

-- The same filter as a plain subquery
create view v3 as select id, x from b where (select b.x from u) > 0;
update v3 set x = 200;       -- works, updates row 1 only
```

The failed update leaves the table unchanged.

## Cause

When a write through a view is lowered to a write on the base table, column references in the view's filter are rewritten to the lowered statement's columns. `cloneWithClause` in `scope-transform.ts` deliberately skips that rewrite for WITH bodies, and its comment gives the reason as "a CTE body cannot correlate to the enclosing query". That statement is false: a WITH body inside a subquery can read the enclosing row, and `07.8.2-subquery-selecting-outer-column.sqllogic` covers such shapes on the read path. The un-rewritten `b.x` then has nothing to bind to.

## Expected behaviour

The update behaves like the `v3` case and changes only row 1. If rewriting WITH bodies during lowering turns out to be unsound, the alternative is a rejection whose message says that a view filter's WITH query cannot read the view's row in a write. Either way, the three comments making the false claim need correcting.
