description: Review of planner infrastructure (framework, cost, cache, validation, debug)
files:
  packages/quereus/src/planner/framework/characteristics.ts
  packages/quereus/src/planner/framework/context.ts
  packages/quereus/src/planner/framework/pass.ts
  packages/quereus/src/planner/framework/physical-utils.ts
  packages/quereus/src/planner/framework/registry.ts
  packages/quereus/src/planner/framework/trace.ts
  packages/quereus/src/planner/cost/index.ts
  packages/quereus/src/planner/debug/logger-utils.ts
  packages/quereus/src/planner/cache/correlation-detector.ts
  packages/quereus/src/planner/cache/materialization-advisory.ts
  packages/quereus/src/planner/cache/reference-graph.ts
  packages/quereus/src/planner/validation/determinism-validator.ts
  packages/quereus/src/planner/validation/plan-validator.ts
  packages/quereus/src/planner/util/key-utils.ts
  packages/quereus/src/planner/debug.ts
  packages/quereus/src/planner/optimizer.ts
  packages/quereus/src/planner/optimizer-tuning.ts
  packages/quereus/src/planner/planning-context.ts
  packages/quereus/src/planner/resolve.ts
  packages/quereus/src/planner/type-utils.ts
----
## Findings

### defect: `isColumnBindingProvider` operator precedence bug
file: packages/quereus/src/planner/framework/characteristics.ts:301-303
Missing parentheses around `||` caused the `'getBindingRelationName' in node` guard to only apply to the `string` branch, not the `function` branch. While unlikely to produce false positives in practice (accessing a missing property yields `undefined`, not `'function'`), the logic was incorrect and fragile.
Ticket: fixed in review

### smell: duplicate constant folding in `optimizeForAnalysis`
file: packages/quereus/src/planner/optimizer.ts:314-316
`optimizeForAnalysis` called `this.performConstantFolding()` manually, then called `passManager.executeUpTo(_, _, PassId.Structural)` which runs the constant folding pass again (order 0 < Structural order 10). Constant folding is idempotent so this was not a correctness issue, but it was wasted work. Removed the manual call and the now-dead `performConstantFolding` private method plus its unused imports.
Ticket: fixed in review

### note: `PredicateAnalysis.predicateReferencesOnly` is a TODO stub
file: packages/quereus/src/planner/framework/characteristics.ts:484-488
Always returns `true`. The `PredicateAnalysis.canPushDown` method uses this, but actual predicate pushdown in the optimizer rules performs its own column reference analysis, so this stub is not actively harmful. The `PredicateAnalysis` class appears to be unused infrastructure.

### note: `isLikelyRepeated` heuristic is misleading
file: packages/quereus/src/planner/framework/characteristics.ts:102-105
The method checks `hasSideEffects` which is orthogonal to being "likely repeated". This heuristic feeds into `CachingAnalysis.shouldCache`, but the `CachingAnalysis` class is not referenced by the active materialization advisory path (which uses `ReferenceGraphBuilder` instead). Low impact.

### note: potential double-traversal in `ReferenceGraphBuilder.visitAllChildren`
file: packages/quereus/src/planner/cache/reference-graph.ts:130-161
`getChildren()` and `getRelations()` may overlap. The code handles this correctly via the `parents` Set dedup for parent counting, but the recursive traversal runs twice for overlapping children. Minor performance concern for large plans.

### note: pre-existing test failure in keys-propagation
file: packages/quereus/test/optimizer/keys-propagation.spec.ts:38
`Join combines keys for inner join (conservative)` fails due to `json_group_array(properties)` producing `[object Object]` instead of JSON. Already tracked at tickets/fix/fix-keys-propagation-test.md.

## Trivial Fixes Applied
- characteristics.ts:301-303 -- added parentheses to fix `||` precedence in `isColumnBindingProvider`
- context.ts:55-63,72 -- fixed mixed 2-space/tab indentation in `OptimizerDiagnostics` and `OptimizationContext.diagnostics`
- optimizer.ts:314-316 -- removed duplicate constant folding call in `optimizeForAnalysis`
- optimizer.ts:326-336 -- removed dead `performConstantFolding` private method
- optimizer.ts:41-42 -- removed unused `performConstantFolding`/`createRuntimeExpressionEvaluator`/`createRuntimeRelationalEvaluator` imports

## No Issues Found
- framework/pass.ts -- clean, well-structured pass management with proper depth limiting and cycle detection
- framework/registry.ts -- clean, proper duplicate detection and priority ordering
- framework/trace.ts -- clean, proper hook composition pattern
- framework/physical-utils.ts -- clean, correct ordering/key projection logic
- cost/index.ts -- clean, straightforward cost formulas
- debug/logger-utils.ts -- clean
- cache/correlation-detector.ts -- clean, correct attribute collection and external reference detection
- cache/materialization-advisory.ts -- clean, well-structured decision framework
- validation/determinism-validator.ts -- clean, proper result-object pattern
- validation/plan-validator.ts -- clean, thorough invariant checking
- util/key-utils.ts -- clean, correct key coverage analysis
- debug.ts -- clean, proper plan serialization and formatting
- optimizer-tuning.ts -- clean
- planning-context.ts -- clean, well-typed context with dependency tracking
- resolve.ts -- clean, proper symbol resolution with fallback
- type-utils.ts -- clean

## Test Coverage
Tests exist for: characteristics (characteristics.spec.ts), pass manager (pass-manager.spec.ts), reference graph (reference-graph.spec.ts), and the optimizer rules that use this infrastructure are well-covered by optimizer/*.spec.ts and plan/golden-plans.spec.ts. 472 tests pass; 1 pre-existing failure (keys-propagation, already tracked).
