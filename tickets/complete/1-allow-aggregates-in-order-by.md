description: Permit aggregate functions in ORDER BY when the query is itself an aggregate query
prereq:
files:
  packages/quereus/src/planner/building/select.ts
  packages/quereus/src/planner/building/select-aggregates.ts
  packages/quereus/src/planner/building/select-modifiers.ts
  packages/quereus/test/logic/07.3-group-by-extras.sqllogic
  docs/sql.md
  docs/sqlite-test-crosscheck.md
----

## What was built

`ORDER BY` can now reference aggregate functions whenever the surrounding query is already an aggregate query (i.e. has aggregates in `select`/`having`, or has `group by`). Previously every aggregate in `ORDER BY` was rejected with `Aggregate function <name> not allowed in this context` even though once a query is aggregating the per-group output rows are well-defined.

A non-aggregate query — e.g. `select id from t order by sum(val)` — still returns the same error: there is no aggregation context to attach the aggregate to.

## Key files

- `packages/quereus/src/planner/building/select-aggregates.ts` — `buildAggregatePhase` now mirrors the HAVING-only-aggregate pattern: it walks each ORDER BY expression with `findAggregateFunctionExprs` and, when the query is aggregate, appends novel aggregates to the `AggregateNode`. New helpers `collectOrderByAggregates`, `orderByContainsAggregates`, and shared dedupe `dedupeNewAggregates`. Returns `hasOrderByOnlyAggregates`, `orderByHasAggregates`, and a single shared `aggregatesContext` used downstream. `handlePreAggregateSort` skips the `ORDER BY → SortNode → AggregateNode` rewrite when ORDER BY references aggregates.
- `packages/quereus/src/planner/building/select-modifiers.ts` — `applyOrderBy` gained an `allowAggregates` flag.
- `packages/quereus/src/planner/building/select.ts` — threads `aggregateResult.aggregatesContext` into `selectContext.aggregates`; promotes `hasAggregates = true` when HAVING-only or ORDER-BY-only aggregates were added (also fixes a latent HAVING-only branching bug); applies ORDER BY *before* the stripping final projection when ORDER BY references aggregates (gated on `!hasWindowFunctions`).
- `packages/quereus/test/logic/07.3-group-by-extras.sqllogic` — new test bucket for ORDER BY aggregates (CASE-grouped + aggregate ORDER BY, scalar aggregate self-ordering, explicit aggregate vs. alias parity, ORDER-BY-only aggregate, negative case for non-aggregate query).
- `docs/sql.md`, `docs/sqlite-test-crosscheck.md` — ORDER BY section now documents aggregate support; cross-check entry for `groupby.test` notes the new ORDER-BY-aggregate coverage.

## Testing & validation

- `yarn build` — clean.
- `yarn test` (quereus workspace) — 2523 passing, 3 pending.
- `yarn lint` (eslint, packages/quereus) — clean.
- Logic tests in `07.3-group-by-extras.sqllogic` exercise:
  - CASE-grouped query with `order by count(*) desc, <case>` (was previously a `-- TODO bug:`).
  - Scalar aggregate self-ordering: `select count(*) as c from aob order by count(*);`
  - Alias-vs-explicit aggregate parity: `... order by s desc` vs `... order by sum(val) desc`.
  - Aggregate referenced *only* in ORDER BY (forces the ORDER-BY-only path: aggregate added to `AggregateNode`, sort applied before strip projection, aggregate stripped from output).
  - Negative case: `select id from aob order by sum(val);` → `Aggregate function sum not allowed in this context`.

## Usage

```sql
-- Aggregate in ORDER BY when the query has GROUP BY
select grp, count(*) as cnt from t group by grp order by count(*) desc;

-- Aggregate referenced only in ORDER BY (not in SELECT)
select grp from t group by grp order by max(val) desc;

-- Aggregate in ORDER BY of a scalar-aggregate query (no GROUP BY)
select count(*) from t order by count(*);

-- Composite ORDER BY mixing aggregates and group-by expressions
select case when val < 20 then 'low' else 'high' end as bucket, count(*) as cnt
from t group by case when val < 20 then 'low' else 'high' end
order by count(*) desc, case when val < 20 then 'low' else 'high' end;
```

## Review notes

- The aggregate-detection helpers (`findAggregateFunctionExprs`) are AST-recursive and skip aggregate-argument descent (nested aggregates are invalid SQL anyway). Coverage of expression kinds (`binary`, `unary`, `cast`, `collate`, `between`, `in`, `case`) matches the rest of the planner's AST walks.
- `dedupeNewAggregates` keys on `expressionToString(funcExpr).toLowerCase()`, matching how `existingAggregates` are keyed via the wrapped `AggregateFunctionCallNode.expression`. A duplicate aggregate referenced in both SELECT and ORDER BY (or in HAVING and ORDER BY) is collected only once.
- The `orderByAppliedEarly` flag in `select.ts` correctly suppresses the post-projection `applyOrderBy`. The early-apply path is gated on `!hasWindowFunctions` so the window pipeline (whose output isn't yet visible at that point) is undisturbed.
- The HAVING-only-aggregate latent bug (a HAVING-only aggregate query falling into the non-aggregate final-projection branch) is now also fixed by the `hasAggregates = true` promotion.
