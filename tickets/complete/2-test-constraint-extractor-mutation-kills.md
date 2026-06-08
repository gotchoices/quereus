description: Mutation-killing tests for constraint-extractor.ts — raised Stryker mutation score from 47.97% to 68.86% (78.76% covered)
prereq: none
files:
  packages/quereus/test/planner/constraint-extractor.spec.ts (203 unit tests, 71 describe blocks, ~2555 lines)
  packages/quereus/test/logic/106-constraint-extractor-mutation-kills.sqllogic (~60 end-to-end queries)
  packages/quereus/src/planner/analysis/constraint-extractor.ts (unchanged — test-only ticket)
---

## Summary

Test-only work that drives mutation score on `constraint-extractor.ts` from a baseline of 47.97% (from the zero-bug-plan session) to **68.86%** detected (356/517), with 78.76% covered. No production code changed.

Two test layers:

**Unit tests** (`test/planner/constraint-extractor.spec.ts`): Direct calls to `extractConstraints`, `computeCoveredKeysForConstraints`, and `createResidualFilter` using hand-built `ScalarPlanNode` trees (helpers: `colRef`, `lit`, `paramRef`, `binOp`, `andNode`, `orNode`, `betweenNode`, `inNode`, `inSubqueryNode`, `unaryOp`, `castNode`, `makeTableInfo`). Exercises every public export through their public surface.

**SQL logic tests** (`test/logic/106-constraint-extractor-mutation-kills.sqllogic`): End-to-end queries through the full SQL pipeline covering binary ops, flip patterns, BETWEEN, IN/NOT IN, IS NULL/IS NOT NULL, AND decomposition, OR→IN collapse, OR→range gaps, per-table slicing, joins, LIKE, CAST, parameterized queries, aggregates with constraints.

## Coverage areas

- Binary operator mapping (all 8 ops + unsupported → residual)
- `flipOperator` — all reversals plus symmetric ops (LIKE, GLOB, MATCH stay unflipped)
- Literal value extraction (integer, string, null, 0, empty string — no falsy collapse)
- BETWEEN extraction + NOT BETWEEN residual + non-column / non-literal bound edge cases
- IN extraction (literal, mixed dynamic, subquery rejection, non-usable values)
- IS NULL / IS NOT NULL extraction
- AND decomposition (nested, partial extraction)
- OR → IN collapse (same column, different columns, mixed IN+equality, parameter branches)
- OR → OR_RANGE collapse (various bound combos, equality-in-ranges, multi-branch, different columns)
- Per-table constraint grouping (multi-table predicates on joins)
- Residual predicate shape (0, 1, 2+ residuals)
- Covered keys (equality, single-value IN, composite keys, zero-length keys)
- Dynamic binding metadata (literal, parameter, correlated, expression, mixed)
- CastNode unwrapping (column, literal, parameter through cast)
- `usable` flag verification on BETWEEN, IS NULL, IS NOT NULL constraints
- Column index mapping edge cases (empty columnIndexMap)
- `createResidualFilter` stub behavior

## Score ceiling (remaining undetected mutants)

- **NoCoverage (65)**: Plan-level functions (`extractConstraintsForTable`, `extractConstraintsAndResidualForTable`, `analyzeRowSpecific`, `demoteForAggregate`, `demoteAllBeneath`, `collectRelationKeysBeneath`, `createTableInfosFromPlan`, `walkPlanForPredicates`) reachable only via full `RelationalPlanNode` trees through the optimizer pipeline.
- **Equivalent (~20)**: `isAndExpression`/`isOrExpression` nodeType-vs-operator dualism; `relationKey || relationName` where relationKey always wins; array-index-into-empty returning undefined; dead branches behind `isDynamicValue` guards; `mapOperatorToConstraint`/`flipOperator` IN/NOT-IN cases never reached through `extractBinaryConstraint`.
- **Survived (~20-30)**: `collapseBranchesToIn` and `tryCollapseToOrRange` internal BlockStatement mutations where outer structure still produces valid empty results.

## Validation

- `yarn test` (full quereus suite): **2419 passing, 2 pending** ✓
- `npx eslint 'test/planner/constraint-extractor.spec.ts'`: clean ✓
- No production code changed — pure test addition ✓

## Usage / re-running mutation

```
cd packages/quereus
npx stryker run stryker.config.mjs --mutate "src/planner/analysis/constraint-extractor.ts"
```

Future work to close the NoCoverage gap would require tests that build full `RelationalPlanNode` trees (filters over joins / aggregates / subqueries) and invoke the plan-level extractors. That is a separate, larger ticket — the present unit layer is the right seam for operator-level invariants.
