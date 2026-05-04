---
description: Reject SELECT queries that mix non-aggregate, non-GROUP-BY columns with GROUP BY/aggregates. Today the planner silently accepts e.g. `select grp, count(*), val from t group by grp`. The corpus's `07-aggregates.sqllogic:74` already asserts the right error message; the engine just doesn't raise it.
prereq:
files: packages/quereus/src/planner/building/select-aggregates.ts, packages/quereus/test/logic/07-aggregates.sqllogic
---

# Implement aggregate / GROUP BY coverage validation

## Context

`validateAggregateProjections` in `select-aggregates.ts:159-170` only handles the `hasAggregates && !hasGroupBy` case. It never checks the `hasGroupBy` case, so non-aggregate, non-grouped column references in the SELECT list (e.g. `val` in `select grp, count(*), val from agg_t group by grp`) flow through and are executed with an implementation-defined value.

`analyzeSelectColumns` (`select-projections.ts:132`) splits SELECT items into:
- `aggregates`: direct aggregate calls and scalar-wrapped aggregates
- `projections`: everything else (column refs, literals, expressions)

So at the validation point, the `projections` array passed to `buildAggregatePhase` contains exactly the non-aggregate items that need GROUP BY coverage.

## Approach

1. Move the validation call to **after** `groupByExpressions` is built (currently it runs before — see `select-aggregates.ts:88` vs. `:91-92`).
2. Extend `validateAggregateProjections` to handle `hasGroupBy`:
   - Collect `attributeId`s of every GROUP BY expression that is a direct column reference (`CapabilityDetectors.isColumnReference`).
   - For each `Projection`, walk its scalar tree:
     - Skip subtrees rooted at an aggregate function call (`CapabilityDetectors.isAggregateFunction`) — the inner column refs are aggregated and need no coverage.
     - For each `ColumnReferenceNode`, require that its `attributeId` is in the GROUP BY attr-id set.
     - Literals/parameters/etc. without column references are fine.
   - On first uncovered column ref, throw:
     ```ts
     new QuereusError(
       `Cannot mix aggregate and non-aggregate columns in SELECT list without GROUP BY`,
       StatusCode.ERROR,
     );
     ```
   The wording must match `07-aggregates.sqllogic:75` exactly (the `executeExpectingError` matcher does substring containment, but the existing no-GROUP-BY branch uses exactly this wording — keep them identical).

This is intentionally stricter than full functional-dependency coverage (no PK-based FD inference): the corpus only needs the simple "column ref in GROUP BY" rule, and SQLite's permissive non-standard expansion (the "bare columns" rule) is not something we want to import. If a more permissive check is needed later, lift the unique-key cover analysis from `constraint-extractor.ts:1027-1058`.

## Acceptance

- `07-aggregates.sqllogic:74` raises the asserted error against quereus.
- Existing passing aggregate tests continue to pass (verify the constant-literal case at `:70` and scalar-wrapping-aggregate cases at `:78-93` are not regressed).
- Full `yarn test` passes.

## Caveat

Until `sqllogic-error-directive-ordering` lands, `executeExpectingError` will tautologically pass even without this fix. After both land, the test asserts real engine behavior.

## Out of scope

- HAVING clause column-coverage validation. The ticket mentions `select-aggregates.ts:62-66` but that range only covers the `shouldPushHavingBelowAggregate` heuristic, not non-grouped column refs in HAVING. Add a follow-up backlog ticket only if a corpus case starts asserting it.
- Functional-dependency / unique-key coverage. Stricter than SQLite, but matches the corpus and SQL-92.

## TODO

- Move the `validateAggregateProjections` call below the `groupByExpressions = stmt.groupBy ? stmt.groupBy.map(...)` line in `buildAggregatePhase`.
- Extend `validateAggregateProjections` signature to accept `groupByExpressions: ScalarPlanNode[]`.
- Implement the GROUP BY coverage walk:
  - Build a `Set<number>` of GROUP BY attribute IDs from column-reference GROUP BY expressions.
  - Add a small helper `findUngroupedColumnRef(node, groupByAttrIds): ColumnReferenceNode | null` that recurses through `node.getChildren()`, short-circuiting on aggregate function calls, and returns the first uncovered `ColumnReferenceNode`.
  - Throw with the exact corpus-asserted message on a hit.
- Run `yarn test --grep "07-aggregates"` (or the package-local equivalent) to confirm the assertion fires.
- Run `yarn test` for the full suite.
- Run `yarn workspace @quereus/quereus lint` to confirm no lint regressions.
