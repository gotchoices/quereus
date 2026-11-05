description: When a query mentions a WITH query twice under the same name, the engine counts that as one use and runs it separately for each mention, so a body using a random value gives the two mentions different answers even though other double uses share one result.
architecture: docs/runtime-caching.md#shared-cte-materialization-multi-reference-ctes
files:
  - packages/quereus/src/planner/building/select.ts  # cteReferenceCache, ~line 535: one CTEReferenceNode per name + alias
  - packages/quereus/src/planner/cache/materialization-advisory.ts  # shouldMaterializeCTE and the recursive branch read the parent count this produces
repro: verified
severity: wrong-result
likelihood: unusual
tradeoffs: It only shows with a non-deterministic body, or an expensive one that runs twice, and the fix has to count mentions rather than plan nodes, which may be more change than the rare shape justifies.
----

## What happens

The two statements below should agree, since each names `c` twice and `docs/sql-select.md` says a WITH query referenced two or more times is stored once:

```sql
create table u (id integer primary key);
insert into u values (1);

-- Two aliases: stored once, same = true
with c as (select random() as x from u) select c1.x = c2.x as same from c c1 join c c2 on 1=1;

-- One name mentioned twice: runs twice, same = false
with c as (select random() as x from u) select (select max(x) from c) = (select min(x) from c) as same;
```

## Cause

`buildFrom` keeps one `CTEReferenceNode` per name and alias in `cteReferenceCache`, so both mentions in the second statement reuse a single node. `MaterializationAdvisory` decides by counting a `CTENode`'s parents, sees one, and leaves the body streaming, while each mention still emits and runs it. The advisory's doc comment already notes this undercount, because it is why a data-modifying WITH is marked at build time instead.

## Related behaviour

The undercount also lets some shapes skip the refusals for a WITH body that reads the outer row (see `docs/runtime-caching.md`). A non-deterministic body that reads the outer row and is mentioned twice under one name runs per mention instead of being refused, and gives the two mentions different values.

A recursive body that reads the outer row, mentioned twice under one name, is not refused either. That one gives correct results and is pinned as a passing case in `07.8.2-subquery-selecting-outer-column.sqllogic`, so a fix that counts mentions must keep it working, either by running each mention's recursion separately or by deciding deliberately to refuse it and updating that test.

## Expected behaviour

Reference counting reflects how many times the query names the WITH query, so the second statement above returns `same = true`.
