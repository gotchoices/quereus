description: A subquery that simply selects a column of the outer query, such as `(select t.b from u)`, is treated as if it did not depend on the outer row, so every outer row gets the first row's value. Queries return wrong answers, and a CHECK written this way lets bad rows into a table during a multi-row insert.
files:
  - packages/quereus/src/planner/cache/correlation-detector.ts  # collectDefinedAttributes counts a pass-through output as defined by the subquery
  - packages/quereus/src/planner/nodes/project-node.ts  # a projected plain column keeps its source's attribute id
  - packages/quereus/src/planner/rules/cache/rule-scalar-subquery-cache.ts  # wraps the subquery in a cache once it reads as uncorrelated
  - packages/quereus/src/runtime/emit/subquery.ts  # the IN set probe takes the same gate
repro: verified
----

## Symptom

Measured on the `dist` build, memory module, with `u` holding one row and `t` holding `(1, 5), (2, -5), (3, 9)` as `(a, b)`:

| Query | Result for `m` or the rows returned | Correct |
|---|---|---|
| `select a, (select t.b from u) as m from t` | 5, 5, 5 | 5, -5, 9 |
| `select a, (select x from (select t.b as x from u) d) as m from t` | 5, 5, 5 | 5, -5, 9 |
| `select a, (select max(x) from (select t.b as x from u) d) as m from t` | 5, 5, 5 | 5, -5, 9 |
| `select a, (with c as (select t.b as x from u) select max(x) from c) as m from t` | 5, 5, 5 | 5, -5, 9 |
| `select a from t where (select t.b from u) > 0` | rows 1, 2, 3 | rows 1, 3 |
| `select a, (select t.b + 0 from u) as m from t` | 5, -5, 9 | correct |
| `select a, (select max(t.b) from u) as m from t` | 5, -5, 9 | correct |

The same fault lets a violating row into a table. With `create table w (a integer primary key, b integer null, check ((select new.b from u) > 0))`, the statement `insert into w values (1, 5), (2, -5)` succeeds and stores the second row. The same holds for a bare `b`, for `t.b`, and for a CHECK that reads the column through an aggregate over a derived table or CTE.

## Cause

`ProjectNode` keeps the source's attribute id when it projects a plain column reference. `collectDefinedAttributes` adds every relational node's output attributes to the set of attributes the subquery defines, so the outer column counts as defined by the subquery and `isCorrelatedSubquery` returns false. `rule-scalar-subquery-cache` then wraps the subquery in a cache. `t.b + 0` and `max(t.b)` mint a new attribute, so the reference stays external and those shapes are right. The plan for the third row above shows `SCALARSUBQUERY` over `CACHE`.

The cause is inferred from the code and fits every row above; nobody has yet confirmed it by changing the detector. `isCorrelatedSubquery` has other callers, listed by searching for it, including join reordering, semi-join pushdown and subquery decorrelation, so they may be misled by the same shape.

## Expected behavior

A subquery that reads an outer column is correlated, whichever way it reaches its output, and it is evaluated for each outer row.

A materialized CTE is a second, separate limit. It keeps one buffer per execution (`emitCTE`), so a CTE whose body reads the outer row and which is referenced twice still reuses the first row's value after this is fixed. That shape needs its own answer here: refuse it, or stop materializing such a body.
