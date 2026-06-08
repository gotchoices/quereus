description: OR conditions in constraint extraction and predicate pushdown
prereq: constraint-extractor, predicate-normalizer, rule-select-access-path
----

## What was built

OR-of-equality disjunctions are extracted as IN constraints and pushed down to indexes for multi-seek execution. The predicate normalizer collapses `col = A OR col = B OR col = C` into `col IN (A, B, C)`, and the constraint extractor handles both the pre-collapsed IN form and mixed equality+IN branches from nested OR normalization.

### Key files

- `packages/quereus/src/planner/analysis/constraint-extractor.ts` — `flattenOrDisjuncts()`, `tryExtractOrBranches()`, `collapseBranchesToIn()` for OR extraction; extended `extractInConstraint` for non-literal IN values
- `packages/quereus/src/planner/rules/access/rule-select-access-path.ts` — uses `valueExpr` array for mixed-binding IN seek keys
- `packages/quereus/test/optimizer/predicate-analysis.spec.ts` — unit tests (6 OR cases)
- `packages/quereus/test/optimizer/extended-constraint-pushdown.spec.ts` — integration + plan tests (6 correctness + 3 plan verification)
- `docs/optimizer.md` — Known Issues and Future Directions updated

### Testing

- 6 unit tests: same-column IN, three-way, different columns (residual), non-extractable (residual), ranges (residual/Phase 2), AND+OR
- 6 integration tests: end-to-end correctness for all OR patterns
- 3 plan verification tests: IndexSeek for same-column OR, no IndexSeek for cross-column OR
- Full suite: all passing, no regressions

### Review notes

- Code follows existing decomposition patterns (small single-purpose functions)
- Correctness invariant upheld: OR with any non-extractable or residual branch stays fully residual
- Deferred: OR multi-range seek and OR-to-UNION rewriting (documented in optimizer.md, tickets exist in `tickets/plan/`)
