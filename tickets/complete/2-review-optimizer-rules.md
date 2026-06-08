description: Systematic review of all optimizer rules
files:
  packages/quereus/src/planner/rules/access/rule-select-access-path.ts
  packages/quereus/src/planner/rules/aggregate/rule-aggregate-streaming.ts
  packages/quereus/src/planner/rules/cache/rule-cte-optimization.ts
  packages/quereus/src/planner/rules/cache/rule-in-subquery-cache.ts
  packages/quereus/src/planner/rules/cache/rule-materialization-advisory.ts
  packages/quereus/src/planner/rules/cache/rule-mutating-subquery-cache.ts
  packages/quereus/src/planner/rules/cache/rule-scalar-cse.ts
  packages/quereus/src/planner/rules/distinct/rule-distinct-elimination.ts
  packages/quereus/src/planner/rules/join/rule-join-greedy-commute.ts
  packages/quereus/src/planner/rules/join/rule-join-key-inference.ts
  packages/quereus/src/planner/rules/join/rule-join-physical-selection.ts
  packages/quereus/src/planner/rules/join/rule-quickpick-enumeration.ts
  packages/quereus/src/planner/rules/predicate/rule-filter-merge.ts
  packages/quereus/src/planner/rules/predicate/rule-predicate-pushdown.ts
  packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts
  packages/quereus/src/planner/rules/retrieve/rule-projection-pruning.ts
  packages/quereus/src/planner/rules/subquery/rule-subquery-decorrelation.ts
----
## Findings

### note: Type safety casts in rule-select-access-path
file: packages/quereus/src/planner/rules/access/rule-select-access-path.ts
Numerous `as any` and `as unknown as` double casts throughout the file (lines 53, 102, 136, 149, etc.). These work correctly in practice but reduce type safety — future refactoring could introduce bugs that the type system won't catch.
Ticket: not warranted — widespread pattern across the codebase, not specific to this rule

### note: AST reconstruction via `as any` in rule-filter-merge
file: packages/quereus/src/planner/rules/predicate/rule-filter-merge.ts:36
The pattern `(predicate as any).expression` constructs AST.BinaryExpr nodes using `as any` casts. All ScalarPlanNode subtypes have an `.expression` property, but the types differ. The resulting AST nodes may have mismatched `left`/`right` types. Works because the runtime emitter uses PlanNode children, not AST children, but could cause issues if AST introspection is added later.
Ticket: not warranted — low risk, would require broader AST refactoring

### note: Wasteful double-traversal in materialization-advisory
file: packages/quereus/src/planner/rules/cache/rule-materialization-advisory.ts:48
The rule iterates relations and calls `analyzeAndTransform()` individually, then if any changed, re-analyzes the entire tree from the top. The individual results are discarded. Not incorrect, but performs redundant work.
Ticket: not warranted — optimization advisory is not a hot path

### note: Redundant traversal in containsOperationsWithSideEffects
file: packages/quereus/src/planner/rules/cache/rule-mutating-subquery-cache.ts:96
`containsOperationsWithSideEffects` iterates both `getChildren()` and `getRelations()`. Since `getChildren()` returns all children (including relational ones), and `getRelations()` returns only relational children, there is overlap. Not a bug, just mildly wasteful.
Ticket: not warranted — minor

### note: Pre-existing test failure in keys-propagation
file: packages/quereus/test/optimizer/keys-propagation.spec.ts:38
Test "Join combines keys for inner join (conservative)" expects `uniqueKeys` in plan properties but doesn't find it. Pre-existing failure unrelated to rule logic.
Ticket: tickets/fix/fix-keys-propagation-test.md (already exists)

## Trivial Fixes Applied
- rule-predicate-pushdown.ts:44 — Fixed space indentation to tabs (editorconfig: tabs)
- rule-predicate-pushdown.ts:55 — Changed `scope: any` to `scope: Scope` with proper import
- rule-predicate-pushdown.ts:57-81 — Fixed space indentation in Retrieve pushdown block to tabs

## No Issues Found
- rule-select-access-path.ts — correct applicability guards, handles all access patterns (seq scan, index seek, range, OR_RANGE, prefix-range, ordering-only)
- rule-aggregate-streaming.ts — sound cost-based selection between stream and hash aggregate
- rule-cte-optimization.ts — correct materialization/caching heuristics
- rule-in-subquery-cache.ts — proper guards for correlation, determinism, double-caching
- rule-mutating-subquery-cache.ts — correctly detects side effects, skips physical join nodes
- rule-scalar-cse.ts — sound fingerprint-based CSE with proper chain collection
- rule-distinct-elimination.ts — correct uniqueKeys and logical keys checks
- rule-join-greedy-commute.ts — safe INNER/CROSS-only commutation
- rule-join-key-inference.ts — diagnostic-only (returns null), FK→PK detection delegated correctly
- rule-join-physical-selection.ts — correct equi-pair extraction, cost comparison, build/probe side selection
- rule-quickpick-enumeration.ts — correct join graph extraction, greedy NN + bushy plan generation
- rule-filter-merge.ts — correct iterative AND-combination of adjacent filters
- rule-predicate-pushdown.ts — correct pushdown safety (Sort, Distinct, Alias, eligible Project, Retrieve); correctly rejects Limit, Aggregate, Join
- rule-grow-retrieve.ts — correct module capability testing (supports + index-style fallback), correlated subquery handling
- rule-projection-pruning.ts — correct Project-on-Project pruning with attribute ID preservation
- rule-subquery-decorrelation.ts — correct EXISTS→semi, NOT EXISTS→anti, IN→semi transforms; proper correlation extraction
