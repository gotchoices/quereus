---
description: Comprehensive review plan for optimizer subsystem (rules, framework, analysis)
prereq: none

---

# Optimizer Subsystem Review

## Goal

Conduct an adversarial review of the query optimizer to identify correctness risks, missing tests, and high-leverage refactors. In particular, validate rule termination, physical property propagation, and attribute ID stability across transformations.

## Scope

- **Framework**: Pass manager, rule registry, optimization context (`src/planner/framework/`)
- **Rules**: All optimization rules (`src/planner/rules/`)
- **Analysis**: Constraint extraction, predicate normalization, binding collection (`src/planner/analysis/`)
- **Integration**: Planner-optimizer boundary (attribute ID preservation)

## Non-goals

- Runtime execution review (see `review-core-runtime.md`)
- Planner AST-to-plan conversion (see `review-core-planner.md`)
- Virtual table implementation (see `review-core-vtab.md`)

## Checklist

### Rule Application Correctness

- [x] **Rule termination / convergence**: Add a local fixpoint loop in pass application and a regression test covering an explicit A→B→A rewrite cycle.
- [x] **Visited tracking semantics**: Wire `visitedRules` into the pass framework and inherit visited state across rewrite chains so rule application remains terminating even as node IDs change.
- [x] **Depth limiting**: Enforce `tuning.maxOptimizationDepth` during pass traversal and add a regression test for deep nesting.

### Physical Property Propagation

- [x] **Ordering analysis**: Implement the trivial “ordered-by-grouping-keys” check for streaming aggregation and add a regression test (no redundant sort inserted).
- [x] **Unique key propagation**: Keep existing key projection logic and add consistent ordering projection via shared utilities.
- [ ] **Cost model sanity**: Deferred (no changes in this task).

### Attribute ID Preservation

- [ ] **Attribute collection correctness**: Deferred (no walker refactors in this task).
- [ ] **Attribute ID uniqueness**: Confirm attribute combination/merging logic cannot silently create duplicate IDs or cross-wire IDs across different sources.
- [x] **Transformation stability**: Add a regression test asserting `attributeId` stability across aliasing + `order by` references.

### Code Quality

- [x] **DRY hotspots**: Add a shared `projectOrdering()` helper to mirror existing key projection patterns and use it from `ProjectNode` and `ReturningNode`.
- [ ] **Large functions**: Flag the biggest readability/maintainability offenders and propose a decomposition plan (don’t refactor “just because”; prioritize things that reduce bug surface area).
- [ ] **Constraint extraction complexity**: Review `packages/quereus/src/planner/analysis/constraint-extractor.ts` for correctness and maintainability. If it’s becoming a “god function”, decide on an incremental decomposition strategy and capture it as follow-up work.

### Framework Tests

- [x] **Pass manager tests**: Add tests for termination (A→B→A) and depth limiting.
- [ ] **Rule registry tests**: Cover rule priority ordering, visited tracking, and duplicate registration handling.
- [ ] **Context tests**: Cover context cloning/copying, depth limiting, and any node caching semantics.

### Rule Tests

- [ ] **Rule coverage**: Ensure high-risk rules have direct unit tests (predicate pushdown, join reordering, aggregate/window-related rules, CTE/materialization decisions).
- [ ] **Analysis module tests**: Deferred (no changes in this task).

## Work completed (implementation notes)

- **Pass framework**: `PassManager` now supports local fixpoint rule application with visited tracking and per-pass DAG caching; traversal enforces `maxOptimizationDepth`.
- **Physical properties**:
  - `ProjectNode`/`ReturningNode`: ordering is now remapped through projections (mirrors unique-key projection).
  - `AliasNode`: now preserves ordering/uniqueKeys/estimatedRows.
  - Streaming aggregate ordering check implemented for trivial column refs.
- **New tests**:
  - `packages/quereus/test/optimizer/pass-manager.spec.ts`
  - `packages/quereus/test/optimizer/ordering-propagation.spec.ts`
  - `packages/quereus/test/optimizer/attribute-id-stability.spec.ts`
- **Docs**: updated `docs/optimizer.md` to reflect current pass/caching semantics.

## Deliverables

1. **Findings captured**: Concrete list of correctness risks and missing test cases
2. **Follow-up issues/PRs**: A small set of prioritized fixes/refactors (only if they pay down real risk)
3. **Tests added**: Regression tests for termination, attribute ID stability, and at least one physical-property case
4. **Docs updated**: Update `docs/optimizer.md` if it diverges from implementation (passes, registration, invariants)

## Test Plan

### Unit tests

- Framework: pass execution, registry semantics, context behavior
- Rules: high-risk rules get direct tests with at least one edge case each
- Analysis: constraint extraction, predicate normalization, binding collection

### Integration tests

- Attribute ID stability across planner→optimizer boundary
- Physical property propagation across a small chain of rewrites
- Termination for queries that trigger multiple rule applications

### SQLLogic/regression tests

- Add/extend sqllogic coverage for cases known to be sensitive to optimizer rewrites (predicate pushdown, join ordering, aggregates, CTE decisions).

## Acceptance Criteria

- No known non-terminating optimization cycles (with at least one regression test covering the previously risky pattern)
- Attribute IDs remain stable across optimizer transformations (with at least one regression test)
- Physical properties (ordering, keys) are either correctly propagated or explicitly documented as not yet implemented
- High-risk rules and analysis utilities have focused tests
- Documentation reflects current optimizer architecture and known limitations

## Notes/Links

- Related: `review-core-planner.md` (planner-optimizer integration)
- Related: `review-core-runtime.md` (optimizer-runtime integration)
- Framework docs: `docs/optimizer.md`
- Rule conventions: `docs/optimizer-conventions.md`
