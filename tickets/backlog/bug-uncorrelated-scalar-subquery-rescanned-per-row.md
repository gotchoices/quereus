----
description: A constant subquery like "where x > (select max(y) from t)" is fully re-executed for every row examined instead of being computed once.
prereq: bug-cache-node-stale-across-statement-executions
files: packages/quereus/src/runtime/emit/subquery.ts, packages/quereus/src/planner/rules/cache/rule-in-subquery-cache.ts
----

# Uncorrelated scalar subqueries re-drained per row

`emitScalarSubquery` drains its input pipeline on every evaluation
(`runtime/emit/subquery.ts:73-89`). Scalar expressions are compiled as
sub-programs re-run per row, so an **uncorrelated** scalar subquery in a
WHERE/projection/sort expression re-executes its full pipeline once per row —
`where x > (select max(y) from t)` performs N aggregate scans of `t`.

The only existing memo is for *impure* (DML-bearing) inners
(`subquery.ts:40-62`, a run-once guard for write semantics). Pure uncorrelated
subqueries have no cache: no planner rule targets `ScalarSubqueryNode`
(`rule-in-subquery-cache.ts` covers only `InNode` sources).

Expected: an uncorrelated, functional scalar subquery evaluates once per
execution — either a `CacheNode`-style planner rule (mirroring the IN-subquery
cache) or a pure-path analog of the existing run-once memo, scoped per
execution (see the staleness prereq).

Cheap fix, common shape, large win on high-latency storage backends.
