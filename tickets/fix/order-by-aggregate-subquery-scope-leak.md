----
description: When a grouped (GROUP BY) query has an ORDER BY that contains its own aggregate subquery like `(select count(*) from other)`, that inner aggregate is mistakenly treated as the OUTER query's aggregate, so the subquery returns a whole column instead of one number and the query fails with "Scalar subquery returned more than one row".
files: packages/quereus/src/planner/building/select.ts, packages/quereus/src/planner/building/select-modifiers.ts
----

# ORDER BY aggregate subquery leaks the outer aggregate scope on GROUP BY queries

## Symptom

A `GROUP BY` query whose `ORDER BY` contains a scalar-aggregate **subquery**
throws at runtime:

```
Scalar subquery returned more than one row
```

Minimal repro (both fail the same way; run against a fresh memory db):

```sql
create table o (id integer primary key, k integer null, grp text) using memory;
create table c (id integer primary key, fk integer null, amount integer null) using memory;

-- uncorrelated inner aggregate — still breaks:
select o.k, count(*) as cnt
from o group by o.k
order by (select count(*) from c), o.k;

-- correlated form — same failure:
select o.k, count(*) as cnt
from o group by o.k
order by (select count(*) from c where c.fk = o.k), o.k;
```

## Root cause (as observed)

`query_plan(...)` on the repro shows the ORDER BY subquery
`(select count(*) from c ...)` planned as a **column projection**, not an
aggregate:

```
Sort   ORDER BY (select count(*) from c ...) ASC, o.k ASC
  HashAggregate  GROUP BY o.k  HASH AGG count() AS cnt
  ...
  ScalarSubquery
    Project  SELECT cnt          <-- projects the OUTER aggregate's alias `cnt`
      Filter  WHERE c.fk = o.k
        IndexScan c
```

The subquery's own `count(*)` is resolved against the **enclosing** aggregate's
output scope and bound to the outer aggregate's result column (`cnt`), so the
subquery degenerates into `select cnt from c ...` — a multi-row column read —
instead of computing its own `count(*)`. In scalar context that legitimately
trips the ">1 row" guard.

When the ORDER BY subquery is built for an aggregate query, its inner scope is
inheriting the outer aggregate scope where a bare aggregate call (and the
`cnt` alias) resolves. A nested subquery must open a **fresh** aggregate scope;
the outer aggregate's aggregates/aliases should not be visible to the inner
query's own aggregate resolution.

## Why this is filed separately (not part of the ORDER BY decorrelation ticket)

Discovered while implementing `feat-decorrelate-scalar-subquery-order-by`. It is
**independent of decorrelation**:

- It reproduces with **all** scalar-agg decorrelation rules disabled
  (`disabledRules: scalar-agg-decorrelation, scalar-agg-decorrelation-sort`).
- It reproduces with an **uncorrelated** subquery, so it is not about
  correlation handling at all.
- It is a build/scope-resolution defect in `planner/building`, before any
  optimizer rule runs.

The ORDER BY decorrelation rule simply cannot be exercised on this shape while
the baseline itself throws, so the aggregate-ORDER-BY edge case was dropped from
that ticket's tests (see the NOTE in
`packages/quereus/test/logic/07.7-scalar-agg-decorrelation.sqllogic` and the
review handoff) pending this fix.

## Expected behavior

Both repro queries should run and order the groups by the inner subquery's
value (`count(*)` over `c`, per group), exactly as if the ORDER BY expression
were computed per output row.

## Where to look

- `packages/quereus/src/planner/building/select.ts` — aggregate-phase scope
  construction (`aggregateResult.aggregateScope`, `hasOrderByOnlyAggregates`) and
  the branch that applies ORDER BY while aggregates are in scope.
- `packages/quereus/src/planner/building/select-modifiers.ts` — `applyOrderBy`,
  which builds sort-key expressions under the (possibly aggregate-merged)
  order-by context; a nested subquery built here must not resolve its own
  aggregates against the enclosing aggregate scope.
