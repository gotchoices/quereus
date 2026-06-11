----
description: Review fix for same-table col=col equality seek crash
files:
  - packages/quereus/src/planner/analysis/constraint-extractor.ts
  - packages/quereus/test/logic/100.1-where-extras.sqllogic
  - packages/quereus/test/planner/constraint-extractor.spec.ts
  - packages/quereus/test/optimizer/rule-orderby-fd-pruning.spec.ts
----

# Review: Same-table `col = col` equality seek crash

## What was done

`extractBinaryConstraint` in `constraint-extractor.ts` was treating `b = c` (both columns from the same table) as a seekable `'='` constraint with `bindingKind = 'expression'` and `correlated = false`. The `correlated` flag only checked whether the value column was *outside* the constrained table — it missed the case where the value column is *inside* it.

This caused a `QuereusError: No row context found for column c` crash in `ruleSelectAccessPath` which consumed the constraint as a seek key and emitted the value expression `c` in a context where no row had yet been fetched.

Additionally, `computeCoveredKeysForConstraints` falsely claimed key coverage (e.g., `where b = c and x = 1` over PK `(b, x)` claimed ≤1-row).

### Fix location

`constraint-extractor.ts:424-431` — inside `extractBinaryConstraint`, when the value side (after cast unwrapping) is a `ColumnReference`, added a check for same-table membership via `tableInfo.columnIndexMap.has(rhsAttrId)`. If same-table, returns `null` immediately — leaving the predicate as a residual `FilterNode` correctly evaluated per-row after scan.

```typescript
} else if (innerValue.nodeType === PlanNodeType.ColumnReference) {
    const rhsAttrId = (innerValue as unknown as ColumnReferenceNode).attributeId;
    const sameTable = tableInfo.columnIndexMap.has(rhsAttrId);
    if (sameTable) {
      // Same-table column ref: value is unknown until the row is scanned —
      // can never be a seek key. Decline; the predicate stays as residual.
      return null;
    }
    result.bindingKind = 'correlated';
```

## Tests

- **`100.1-where-extras.sqllogic`**: 4 regression cases exercising PK and composite-PK same-table col=col predicates
- **`constraint-extractor.spec.ts`**: 5 unit tests updated — changed expectation from `bindingKind='expression'` to `allConstraints.length=0` + residual present
- **`rule-orderby-fd-pruning.spec.ts`**: EC-driven test updated — changed to `ORDER BY a DESC, b` so the DESC prevents sort absorption by the heap index, allowing `ruleOrderByFdPruning` to fire on the EC from `WHERE a = b`; before the fix, the predicate was incorrectly pushed down as a seek key, leaving Sort's direct child as Retrieve

## Test results

All tests pass: 5867 passing (quereus), 126 + 62 + 17 passing (other workspaces), 9 pending, no failures.

## Known gaps / reviewer notes

- The fix only covers same-table `ColumnReference` (bare or cast-wrapped via `unwrapCast`). A same-table column embedded in an arithmetic expression like `b = c + 1` still falls through to `bindingKind = 'expression'` — it won't crash (the expression has no row context but arithmetic on an unresolved column ref will error at emit time differently). However, this is a pre-existing edge case and not part of this ticket's scope.
- `isDynamicValue` (which gates the non-literal path) does accept same-table column refs — the fix intercepts them correctly before the result is returned.
