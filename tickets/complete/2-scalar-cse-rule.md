description: Scalar common subexpression elimination optimizer rule
files:
  - packages/quereus/src/planner/rules/cache/rule-scalar-cse.ts
  - packages/quereus/src/planner/optimizer.ts (rule registration)
  - packages/quereus/src/planner/analysis/expression-fingerprint.ts (dependency)
  - packages/quereus/test/optimizer/scalar-cse.spec.ts (11 tests)
  - packages/quereus/test/logic/86-scalar-cse.sqllogic (8 queries)
  - docs/optimizer.md (updated)
----

## Summary

Optimizer rule `ruleScalarCSE` detects duplicate deterministic scalar expressions across a ProjectNode and its immediate child chain (Filter, Sort), injects a lower ProjectNode that computes each deduplicated expression once, and replaces all duplicate occurrences with column references.

### Example transformation
```
ProjectNode [length(name), upper(name)]        ProjectNode [$cse_ref, upper(name)]
  FilterNode [length(name) > 5]          →       FilterNode [$cse_ref > 5]
    SeqScan t                                       ProjectNode [*, length(name) as $cse]
                                                      SeqScan t
```

### Registration
- Pass: Structural (top-down), priority 22
- Node type: `PlanNodeType.Project`
- Rule ID: `scalar-cse`

### Guards
- Only deduplicates deterministic expressions (`physical.deterministic !== false`)
- Skips bare column references, literals, and parameter references
- Requires 2+ distinct node instances sharing the same fingerprint

## Review notes

- Removed dead `replaceInScalar` function (superseded by `replaceAllDuplicates` closure)
- Clean decomposition: `collectChain`, `collectSubexpressions`, `replaceAllDuplicates`
- Expression fingerprinting via `fingerprintExpression()` handles commutative ops, nested functions, etc.
- Attribute IDs properly preserved on outer ProjectNode
- Chain reconstruction always orders Filter above Sort — correct since they commute, and planner always builds Filter below Sort in practice

## Testing

- 11 spec tests covering: projection+filter, projection+filter+sort, non-deterministic guard, bare column guard, multiple filter conditions, intra-projection duplicates, projection+sort, no-op case, nested functions, plan introspection (2 tests)
- 8 sqllogic queries covering same scenarios end-to-end
- All tests pass. Only pre-existing failure: `08.1-semi-anti-join.sqllogic` (unrelated)
