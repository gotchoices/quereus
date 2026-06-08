description: Review of planner scopes, analysis passes, and statistics
files:
  packages/quereus/src/planner/scopes/aliased.ts
  packages/quereus/src/planner/scopes/base.ts
  packages/quereus/src/planner/scopes/empty.ts
  packages/quereus/src/planner/scopes/global.ts
  packages/quereus/src/planner/scopes/multi.ts
  packages/quereus/src/planner/scopes/param.ts
  packages/quereus/src/planner/scopes/registered.ts
  packages/quereus/src/planner/scopes/scope.ts
  packages/quereus/src/planner/scopes/shadow.ts
  packages/quereus/src/planner/analysis/binding-collector.ts
  packages/quereus/src/planner/analysis/const-evaluator.ts
  packages/quereus/src/planner/analysis/const-pass.ts
  packages/quereus/src/planner/analysis/constraint-extractor.ts
  packages/quereus/src/planner/analysis/expression-fingerprint.ts
  packages/quereus/src/planner/analysis/predicate-normalizer.ts
  packages/quereus/src/planner/stats/analyze.ts
  packages/quereus/src/planner/stats/basic-estimates.ts
  packages/quereus/src/planner/stats/catalog-stats.ts
  packages/quereus/src/planner/stats/histogram.ts
  packages/quereus/src/planner/stats/index.ts
----
## Findings

### defect: CatalogStatsProvider introspection helpers use wrong property names
file: packages/quereus/src/planner/stats/catalog-stats.ts:202,276,290,306,319,329
All duck-typed introspection helpers (`extractColumnFromPredicate`, `extractConstantValue`,
`extractBetweenBounds`, `extractEquiJoinColumns`, `estimatePredicateSelectivity`) access
properties that don't exist on the actual plan node types (e.g. `.op` instead of
`expression.operator`, `.value` instead of `expression.value`, `.low`/`.high` instead of
`lower`/`upper`). Result: every helper silently returns `undefined`, so CatalogStatsProvider
never uses real column statistics and always falls through to NaiveStatsProvider heuristics.
Ticket: tickets/fix/catalog-stats-broken-introspection.md

### defect: pushNotDown drops NOT wrapper for non-NOT unary ops
file: packages/quereus/src/planner/analysis/predicate-normalizer.ts:87
When `pushNotDown` encounters a non-NOT unary op (e.g. `NOT(-x)`), it returns the inner
unary op without re-wrapping it in NOT, silently dropping the negation. Both branches of
the ternary on line 87 produce identical results (also a code smell). Low practical impact
since `NOT(unary_minus(x))` is uncommon in SQL.
Ticket: tickets/fix/predicate-normalizer-not-unary-dropped.md

### smell: Type safety issues across analysis/stats modules
file: packages/quereus/src/planner/analysis/predicate-normalizer.ts, catalog-stats.ts, registered.ts, global.ts, histogram.ts
Multiple `as any` casts in predicate-normalizer.ts (lines 131-132, 150, 162, 193, 230-233).
Duplicate methods in registered.ts (`registerSymbol` / `subscribeFactory`). DRY violation in
global.ts (scalarType resolution duplicated). `String()` distinct counting in histogram.ts
conflates types (numeric 1 vs string "1").
Ticket: tickets/plan/planner-analysis-type-safety-cleanup.md

## Trivial Fixes Applied
- param.ts:89-95 — removed commented-out dead code (`getNextAnonymousIndex`)
- index.ts:109 — fixed typo `baseSelecivity` → `baseSelectivity`

## No Issues Found
- scopes/aliased.ts — clean, simple delegation pattern
- scopes/base.ts — clean, minimal abstract class
- scopes/empty.ts — clean, correct singleton
- scopes/multi.ts — clean, proper ambiguity detection for unqualified columns
- scopes/scope.ts — clean, well-defined interface
- scopes/shadow.ts — clean, correct first-match shadowing
- analysis/binding-collector.ts — clean, straightforward tree walk with dedup
- analysis/const-evaluator.ts — clean, proper materializing async iterable with caching
- analysis/const-pass.ts — clean, well-structured three-phase constant folding
- analysis/constraint-extractor.ts — functional (heavy `any` usage noted in plan ticket)
- analysis/expression-fingerprint.ts — clean, correct commutative handling and non-deterministic guards
- stats/analyze.ts — clean, proper reservoir sampling
- stats/basic-estimates.ts — clean, reasonable heuristics

## Test Coverage Notes
- expression-fingerprint.spec.ts — comprehensive unit tests (20+ cases)
- statistics.spec.ts — good coverage for histogram building and catalog stats
- predicate-analysis.spec.ts — moderate coverage for normalization and constraint extraction
- relational-const-folding.spec.ts — good integration tests for const folding
- No dedicated unit tests for scope classes (covered indirectly via integration/sqllogic tests)
- No dedicated unit tests for binding-collector.ts or const-evaluator.ts
