---
description: Semi/anti join infrastructure and correlated subquery decorrelation
prereq: none
---

## Summary

Correlated EXISTS and IN subqueries in WHERE clauses are now transformed into semi/anti joins, enabling hash join selection and eliminating per-row re-execution of inner queries.

### Key Components

- **JoinType**: Extended with `'semi' | 'anti'`; both JoinNode and BloomJoinNode produce left-only output, preserve left-side unique keys, and use 50% selectivity heuristic for row estimation.
- **Decorrelation rule** (`src/planner/rules/subquery/rule-subquery-decorrelation.ts`): Registered in Structural pass at priority 25. Handles correlated EXISTS → semi join, NOT EXISTS → anti join, correlated IN → semi join. Extracts equi-join correlation predicates; preserves inner-only residual filters. NOT IN deferred (NULL semantics).
- **Physical selection** (`src/planner/rules/join/rule-join-physical-selection.ts`): Accepts semi/anti join types; left remains probe side (no swap).
- **Runtime**: Both nested-loop (`src/runtime/emit/join.ts`) and hash join (`src/runtime/emit/bloom-join.ts`) emitters support semi (first-match) and anti (no-match) semantics.

### Testing

- 667 tests passing (0 failures)
- `test/logic/08.1-semi-anti-join.sqllogic`: EXISTS, NOT EXISTS, IN subquery decorrelation, multi-column correlation, NULL handling, mixed predicates, uncorrelated subqueries not decorrelated, scalar subqueries not affected
- `query_plan()` introspection verifies HashJoin nodes with `joinType: "semi"` / `"anti"`

### Documentation

- `docs/optimizer.md`: Added decorrelation and join physical selection rules to reference; updated hash join section for semi/anti support; removed "subquery decorrelation" from future directions
- `docs/architecture.md`: Updated join types and optimizer description
