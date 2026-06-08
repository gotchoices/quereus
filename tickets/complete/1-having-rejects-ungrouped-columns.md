description: Reject HAVING references to non-grouped, non-aggregated columns
prereq:
files:
  packages/quereus/src/planner/building/select-aggregates.ts
  packages/quereus/test/logic/25.2-having-edge-cases.sqllogic
  docs/sql.md
----

## What was built

`HAVING` no longer silently accepts column references that are neither in the `GROUP BY` list nor inside an aggregate function. Such queries now raise:

```
HAVING references non-grouped column '<name>'; HAVING may only reference GROUP BY columns or aggregate expressions
```

The check applies in two shapes:
- `GROUP BY` is present — only `GROUP BY` expressions and aggregate expressions are valid in `HAVING`.
- No `GROUP BY` but the query has aggregates (the implicit single group) — only aggregates are valid; bare column references are rejected.

When the query has neither aggregates nor `GROUP BY`, the existing pre-aggregate `HAVING`-as-`WHERE` push-down still applies and bare references remain valid (they reference per-row state, not a grouped one).

## Key files

- `packages/quereus/src/planner/building/select-aggregates.ts` — `buildHavingFilter` now runs `findUngroupedColumnRef` after the HAVING expression is built against the hybrid scope. The "allowed attribute id" set covers both flavors of valid reference: source-side attribute ids of `GROUP BY` column references, and the `AggregateNode`'s first `groupBy.length + aggregates.length` output attribute ids (which is what aggregate aliases and grouped-column resolution land on through `aggregateOutputScope`). The walker stops descending into aggregate-function subtrees, relational subtrees, and any subtree whose AST fingerprint matches a `GROUP BY` expression — preserving the existing fingerprint-match path (e.g. `group by val * 2 having val * 2 > 10`).
- `packages/quereus/test/logic/25.2-having-edge-cases.sqllogic` — new negative-case bucket plus three positive cases that round out coverage of the rejection paths.
- `docs/sql.md` — HAVING section now documents the column-reference restriction.

## Testing & validation

- `yarn build` — clean.
- `yarn test` — 2523 passing, 3 pending at the implement commit. (The current `main` has one unrelated optimizer-test failure introduced by a later ticket — bisected to `8c9e5686 ticket(review): allow-aggregates-in-order-by`, on `extended-constraint-pushdown.spec.ts:289` — not caused by this work; HAVING coverage is green.)
- `yarn lint` — clean on `select-aggregates.ts`.
- Logic tests in `25.2-having-edge-cases.sqllogic` cover:
  - Negative (error includes the offending column name):
    - `select grp from hu group by grp having id > 0;` — bare ungrouped column.
    - `select grp, sum(val) from hu group by grp having val > 0;` — ungrouped column alongside an aggregate in SELECT.
    - `select grp, sum(val) from hu group by grp having grp = 'a' and val > 0;` — mixed: `grp` is fine, `val` is rejected.
    - `select count(*) from hu having id > 0;` — implicit-single-group form.
  - Positive (still pass):
    - `select grp from hu group by grp having sum(val) > 0;` — aggregate.
    - `select grp from hu group by grp having grp = 'a';` — GROUP BY column.
    - `select val * 2 as v2 from hu group by val * 2 having val * 2 > 30;` — fingerprint-match path.
- All existing HAVING tests across the logic suite continue to pass (e.g. `having count(*) > 1`, `having sum(val) + count(*) > 35`, alias references like `having total > 30`, correlated-subquery HAVINGs).

## Usage

```sql
-- Rejected: bare ungrouped column in HAVING
select grp from t group by grp having id > 0;
-- → HAVING references non-grouped column 'id'; HAVING may only reference GROUP BY columns or aggregate expressions

-- Rejected: ungrouped column in implicit single-group HAVING
select count(*) from t having id > 0;
-- → HAVING references non-grouped column 'id'; ...

-- Allowed: aggregate, GROUP BY column, or fingerprint-matching expression
select grp from t group by grp having sum(val) > 0;
select grp from t group by grp having grp = 'a';
select val * 2 as v2 from t group by val * 2 having val * 2 > 30;
```

## Review notes

- `findUngroupedColumnRef` is shared between `validateAggregateProjections` (SELECT-list coverage check) and `buildHavingFilter` (HAVING coverage check). The SELECT-list call doesn't seed the AggregateNode-output attribute IDs because the SELECT-list builder works against the source scope before the AggregateNode exists. The HAVING call seeds both because resolution there happens through the hybrid scope (aggregate output overlaying the source).
- The walker's stop conditions are deliberately ordered: aggregate-function subtree first (cheapest), AST-fingerprint match second, then column-ref leaf. Anything else descends into children, skipping relational subtrees (subqueries resolve their own scope).
- The error carries the original AST `loc` so editor integrations can surface the line/column of the offending column reference, not just the surrounding HAVING clause.
