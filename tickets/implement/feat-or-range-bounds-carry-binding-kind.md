---
description: When the planner merges "col < :lo or col > :hi" into one multi-range constraint, it forgets which bounds are placeholders, so a storage module cannot safely use them for an index lookup. Keep each bound's kind, give the merged constraint an honest label, and stop the same merge from dropping a bound and returning extra rows.
architecture: docs/module-authoring.md#binding-capture
files:
  - packages/quereus/src/planner/analysis/constraint-extractor.ts   # tryCollapseToOrRange, extractBetweenConstraints, RangeSpec, PredicateConstraint.bindingKind
  - packages/quereus/test/planner/constraint-extractor.spec.ts      # describe('OR → OR_RANGE collapse'); helpers paramRef, binOp, orNode, andNode, betweenNode; TABLE_A, TABLE_B
  - docs/module-authoring.md                                         # § Binding Capture
  - docs/optimizer.md                                                # § Current limitations, OR predicate bullet
difficulty: easy
---

# OR_RANGE bounds carry their binding kind

An `OR_RANGE` constraint is what the planner builds when every branch of an OR is a range or equality on one column. `tryCollapseToOrRange` builds it. This ticket makes two changes in that function, plus one supporting label in `extractBetweenConstraints`.

## Part 1: keep the binding kind

`extractBinaryConstraint` classifies each comparison's value side as a `bindingKind` and sets `correlated` when the value references another table. The collapse copies only `{ op, value, valueExpr }` onto each bound and stamps the whole constraint `bindingKind: 'literal'`, even when every bound is a placeholder.

The lamina storage module needs the per-bound kind. It reads `ranges[i].lower.bindingKind` and `ranges[i].upper.bindingKind`, and it treats a missing kind on a bound with no plan-time value as an unknown shape and declines the whole constraint. So `where price < :lo or price > :hi` scans there instead of seeking two windows. **Keep the field name and the value `'parameter'` exactly as written here.** Lamina's mirror type is in `packages/lamina-quereus/src/plan-types.ts` in the lamina repository, and its follow-up is `feat-late-bound-or-range-claim-after-quereus-bump` on the lamina board.

Name the union once and extend the planner-side type:

```typescript
/** How a constraint's value side is supplied. */
export type BindingKind = 'literal' | 'parameter' | 'correlated' | 'expression' | 'mixed';

export interface RangeSpec extends VtabRangeSpec {
	lower?: { op: '>=' | '>'; value: SqlValue; valueExpr?: ScalarPlanNode; bindingKind?: BindingKind; correlated?: boolean };
	upper?: { op: '<=' | '<'; value: SqlValue; valueExpr?: ScalarPlanNode; bindingKind?: BindingKind; correlated?: boolean };
}
```

`PredicateConstraint.bindingKind` uses the same `BindingKind`.

In the collapse:

- Each bound takes `bindingKind` and `correlated` from the branch constraint that fills it. An equality branch gives both bounds the same values.
- The constraint's `bindingKind` is the shared kind when all bounds have the same kind, including all `'literal'`, and `'mixed'` otherwise. A bound with no kind counts as `'mixed'`. No such bound exists once the BETWEEN change below lands, and a missing kind must not read as literal.
- The constraint's `correlated` is true when any bound's is, false otherwise.

`extractBetweenConstraints` returns two constraints with no `bindingKind`. Set `bindingKind: 'literal'` on both. It only accepts literal bounds, so the label is accurate, and without it an all-literal `a between 1 and 5 or a = 10` would become `'mixed'`.

**Tradeoff: planner-side type only.** The public `RangeSpec` in `vtab/best-access-plan.ts` stays as it is. The scalar `bindingKind` isn't on the public `PredicateConstraint` either, and lamina already mirrors the runtime shape. Filters reach modules by reference (`filters: constraints` in `rule-select-access-path.ts`), so the new fields arrive without further wiring. Publishing the planner-side fields as public types is a separate decision that nothing needs yet.

## Part 2: stop a second bound overwriting the first

A branch may hold two constraints on the column. The collapse assigns them to `spec.lower` and `spec.upper` without checking whether the slot is already filled, so a later constraint replaces an earlier one. The OR is consumed by the seek and no filter remains above it, so the dropped condition is never applied.

Reproduced on the built `dist` with `create table t (a integer primary key)` holding 0, 3, 6, 8, 10:

| Query | Returned | Correct |
| --- | --- | --- |
| `where (a > 7 and a > 5) or a < 1` | 0, 6, 8, 10 | 0, 8, 10 |
| `where (a = 8 and a > 5) or a < 1` | 0, 6, 8 | 0, 8 |

This is the same code as Part 1 and it matters more once Part 1 ships, because lamina would start claiming placeholder shapes such as `(a > :x and a > 5) or a < 1`.

Fix: return `null` from `tryCollapseToOrRange` when a constraint would fill a slot that is already filled. An equality needs both slots free. The whole OR then stays a residual filter, which can only cost speed, never a wrong answer. Do not try to pick the tighter bound, because a placeholder's value isn't known at plan time. Branches with more than two constraints already decline.

## Corrections to the original request

- **`col < :lo + 1 or col > 5` does not produce an `'expression'` bound.** `isDynamicValue` accepts only a parameter or column reference (seen through casts), so `:lo + 1` leaves its branch residual and the whole OR stays a filter (confirmed: filter over an index scan, correct rows). Copying the field handles `'expression'` if it ever becomes reachable. Do not widen `isDynamicValue`; that would change seek emission. Existing tests already pin this residual behaviour, so add no test for it.
- **Setting `correlated` can change one plan decision.** The original request said no existing plan changes. `admitSeekLeaf` Gate 4 (`rules/join/index-nested-loop.ts`, `if (c.correlated === true)`) reads every pushed constraint, not just equalities. A seek whose pushed `OR_RANGE` has a correlated bound passes that gate today and will be declined after this change. That matches the gate's stated purpose ("this leaf is already somebody else's per-outer-row seek"), and the plan falls back to another join strategy with the same rows. Correlated `OR_RANGE` seeks do exist (`exists (select 1 from t where t.a < o.x or t.a > 90)` plans one), but my one attempt to reach the gate with such a seek under a join produced a merge join with no seek leaf, so this comes from reading the code. If a plan test changes, check it against this explanation.

## Expected

Each row is the constraint from the given predicate.

| Predicate | Bounds | Constraint `bindingKind` | Constraint `correlated` |
| --- | --- | --- | --- |
| `a < :lo or a > :hi` | both `'parameter'` | `'parameter'` | false |
| `a < 10 or a > :hi` | `'literal'`, `'parameter'` | `'mixed'` | false |
| `a < u.x or a > 5` | `'correlated'` (bound `correlated: true`), `'literal'` | `'mixed'` | true |
| `a = :p or a > 5` | equality's lower and upper `'parameter'`, other `'literal'` | `'mixed'` | false |
| `a between 1 and 5 or a = 10` | all `'literal'` | `'literal'` | false |
| `(a > 7 and a > 5) or a < 1` | no constraint; OR is residual | n/a | n/a |
| `(a = 8 and a > 5) or a < 1` | no constraint; OR is residual | n/a | n/a |

## Edge cases & interactions

- **Other readers of `bindingKind`:** `change-scope.ts` reads it only inside its `=` arm, so it never sees `OR_RANGE`. The BETWEEN label doesn't reach it either, since BETWEEN emits `>=` and `<=`. Verified by inspection.
- **Other readers of `correlated`:** `computeCoveredKeysForConstraints` skips a flagged constraint before checking its op, and `OR_RANGE` contributes nothing there either way. `index-nested-loop.ts`'s join-key assertion requires `op === '='`. Gate 4 is covered above. Verified by inspection.
- **Seek emission:** `rule-select-access-path`'s `OR_RANGE` arm reads only `op`, `value` and `valueExpr`, so seek keys are unchanged. Existing plan and logic tests verify this.
- **Other modules:** the memory, store and isolation modules ignore the new fields. Existing tests verify this.
- **Reversed and cast operands:** `:lo > a` and `a < cast(:lo as integer)` already classify as `'parameter'` in `extractBinaryConstraint`, and the collapse only copies that result. No new test.
- **Equality and IN collapse first:** `a = :p or a = :q` still becomes `IN`, not `OR_RANGE`. Its handling is unchanged.
- **Lamina claims correlated bounds (for the lamina board, no change here).** The original request says lamina declines correlated values, and lamina's follow-up lists "a correlated bound still declines" as a check. But lamina's current `isClaimableLateBound` accepts both `'parameter'` and `'correlated'`, and its `OR_RANGE` arm calls it. Once this ships, a correlated bound there would be claimed unless lamina changes. Pass this on with the release.
- **Adjacent, not here:** `collapseBranchesToIn` also drops `correlated`. Parked as `debt-or-in-collapse-drops-correlated-flag`.

## TODO

- Add `BindingKind`, extend `RangeSpec`, and use `BindingKind` on `PredicateConstraint`.
- Set `bindingKind: 'literal'` on both constraints in `extractBetweenConstraints`.
- In `tryCollapseToOrRange`, copy `bindingKind` and `correlated` onto each bound and decline when a slot is already filled.
- Compute the constraint's `bindingKind` and `correlated` from its bounds, in a small helper.
- Add unit tests to `describe('OR → OR_RANGE collapse')` covering the rows of the Expected table. The two residual rows are the bug's reproduction: assert no constraints and a residual predicate.
- Add a short paragraph to `docs/module-authoring.md` § Binding Capture: a non-literal `OR_RANGE` bound has `value: undefined`, plus a `valueExpr` and a per-bound `bindingKind`; the constraint's own `bindingKind` summarizes its bounds (`'mixed'` when they differ); only a `'parameter'` bound is fixed for the prepared statement's life.
- Add to the OR bullet in `docs/optimizer.md` § Current limitations: an OR branch with two bounds on the same side stays residual.
- Run `yarn workspace @quereus/quereus run lint` and `yarn workspace @quereus/quereus test`. In the handoff, note the Part 2 behaviour change and the lamina correlated-bound point, and say the lamina follow-up needs a published release.
