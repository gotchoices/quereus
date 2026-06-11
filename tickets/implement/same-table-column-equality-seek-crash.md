----
description: Fix same-table col=col equality crash — constraint extractor was minting a seekable constraint whose value expression required a row context that didn't exist at seek time.
difficulty: easy
files:
  - packages/quereus/src/planner/analysis/constraint-extractor.ts
  - packages/quereus/test/logic/100.1-where-extras.sqllogic
  - packages/quereus/test/planner/constraint-extractor.spec.ts
  - packages/quereus/test/optimizer/rule-orderby-fd-pruning.spec.ts
----

# Same-table `col = col` equality crash — fix already applied

## Root cause

`extractBinaryConstraint` treated `b = c` (both columns from the same table) as a
seekable `'='` constraint with `bindingKind = 'expression'` and `correlated = false`.
The `correlated` flag only checked whether the value column was *outside* the
constrained table — it missed the case where the value column is *inside* it.

Downstream, `ruleSelectAccessPath` consumed the constraint as a seek key and emitted
the value expression (`c`) in a context where no row had been fetched yet, producing:

> QuereusError: No row context found for column c.

The same miscounting made `computeCoveredKeysForConstraints` falsely claim key
coverage (e.g., `where b = c and x = 1` over PK `(b, x)` claimed ≤1-row) — an
overclaim masked by the crash.

## Fix (applied)

In `extractBinaryConstraint` (`constraint-extractor.ts`), added an early `return null`
when the value side is a same-table `ColumnReference`:

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

Returning `null` causes the calling code to leave the predicate as a residual
`FilterNode`, correctly evaluated per-row after the scan.

## Tests updated

**`test/logic/100.1-where-extras.sqllogic`** — 4 new regression cases:
- `select b from samecolpk where b = c` — PK table, 2 matching rows
- `select b from samecolpk where b = c and c != 'x'` — with extra filter
- `select b, c, x from samecolcomp where b = c and x = 1` — composite PK, x pinned
- `select b, c, x from samecolcomp where b = c` — composite PK, b=c only

**`test/planner/constraint-extractor.spec.ts`** — 5 tests updated from
`bindingKind='expression'` expectation to `allConstraints.length=0` +
`residualPredicate` exists:
- `col = sameTableCol → residual (not a constraint, value unknown until scan)`
- `col = col with no literals → residual (same-table col ref can never be a seek key)`
- `col = otherCol (same table) → residual (value unknown until row scanned)`
- bare same-table ref test
- cast-wrapped same-table ref test

**`test/optimizer/rule-orderby-fd-pruning.spec.ts`** — EC-driven test updated:
- Before fix, `WHERE a = b` produced an expression-bound constraint that triggered
  `rulePredicatePushdown`, which moved the Filter into the Retrieve, leaving Sort's
  direct child as Retrieve. After fix, no constraint is extracted so the predicate
  stays as a residual Filter above Retrieve. The `trySortAbsorbViaIndexOrdering` path
  inside `ruleGrowRetrieve` then absorbs `ORDER BY a, b` (the no-PK memory vtab
  claims all-column ordering). The Sort disappears before `ruleOrderByFdPruning` can
  fire.
- Fix: changed test to `ORDER BY a DESC, b` — the DESC direction prevents the
  all-columns ascending index from satisfying the sort, so the Sort survives for
  `ruleOrderByFdPruning` to reduce via the EC from `WHERE a = b`.

## TODO

- Verify `yarn test` passes (all workspaces green — confirmed pre-handoff)
- No further changes needed; implementation is complete
