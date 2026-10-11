---
description: When the planner merges "col < :lo or col > :hi" into one multi-range constraint, it forgets which bounds are placeholders and labels the whole thing as written-out values, so a storage module cannot safely use the placeholder bounds for an index lookup. Keep each bound's binding kind, and give the merged constraint an honest one.
files:
  - packages/quereus/src/planner/analysis/constraint-extractor.ts   # tryCollapseToOrRange (the OR_RANGE collapse); RangeSpec (planner-side bound shape)
  - packages/quereus/test/planner/constraint-extractor.spec.ts      # OR_RANGE extraction tests
  - docs/module-authoring.md                                         # if it describes OR_RANGE bounds or bindingKind
---

# OR_RANGE bounds should carry their binding kind

Filed from the lamina board (`feat-late-bound-or-range-seek-keys`, plan stage). Lamina is the module that needs it; the lamina-side consumer is `late-bound-or-range-seek-keys` on the lamina board.

## What happens today (4.20.2)

`extractBinaryConstraint` classifies every comparison's value side as `bindingKind: 'parameter' | 'correlated' | 'expression' | 'literal'` and sets `correlated` when the value references another table. When an OR's branches are all ranges or equalities on one column, `tryCollapseToOrRange` builds one `OR_RANGE` constraint whose `ranges[i].lower` / `.upper` copy only `{ op, value, valueExpr }` from each branch constraint. Two things are lost:

- **Per-bound binding kind.** A module sees a bound with `value: undefined` and a `valueExpr`, but cannot tell a placeholder (`:lo`) from a column of an outer table or a computed expression without inspecting the plan node itself.
- **Constraint-level honesty.** The collapsed constraint is stamped `bindingKind: 'literal'` unconditionally, even when every bound is a placeholder, and carries no `correlated` flag even when a bound references an outer row.

Lamina claims a placeholder comparison as an index seek only when the engine says the value is a parameter (a parameter's type is frozen for the prepared statement's life, so a plan-time type check holds for every execution). Correlated and computed values are declined. Without a per-bound kind it has to decline every OR_RANGE that contains a non-literal bound, so `where price < :lo or price > :hi` scans instead of seeking two windows.

## Requested change

In `tryCollapseToOrRange`:

- Copy each branch constraint's `bindingKind` onto the bound(s) it fills: `spec.lower.bindingKind` / `spec.upper.bindingKind`. For an equality branch both bounds get the same kind. Also copy `correlated` per bound if that is cheap; lamina does not need it.
- Set the collapsed constraint's `bindingKind` to `'literal'` when every bound is literal, to the shared kind when every bound has the same non-literal kind, else `'mixed'`. Set its `correlated` to true when any bound's is.

Extend the planner-side `RangeSpec` type to match:

```typescript
export interface RangeSpec extends VtabRangeSpec {
	lower?: { op: '>=' | '>'; value: SqlValue; valueExpr?: ScalarPlanNode; bindingKind?: BindingKind; correlated?: boolean };
	upper?: { op: '<=' | '<'; value: SqlValue; valueExpr?: ScalarPlanNode; bindingKind?: BindingKind; correlated?: boolean };
}
```

(`BindingKind` = the existing `'literal' | 'parameter' | 'correlated' | 'expression' | 'mixed'` union on `PredicateConstraint`; name it once if it is not already named.)

Lamina reads exactly `ranges[i].lower.bindingKind === 'parameter'` / `ranges[i].upper.bindingKind === 'parameter'` — please keep that field name and value, or tell the lamina board if it changes.

## Who else reads these fields

At 4.20.2, `bindingKind` is read outside the extractor only by `change-scope.ts` (equality constraints only, not `OR_RANGE`), and `correlated` by `computeCoveredKeysForConstraints` (equality / single-value IN only) and `index-nested-loop.ts` (equality join keys). So the constraint-level change should not alter any existing plan; a quick check of those sites at implement time confirms it.

## Expected

- `col < :lo or col > :hi` → OR_RANGE whose two bounds carry `bindingKind: 'parameter'`; the constraint carries `'parameter'`.
- `col < 10 or col > :hi` → lower-less disjunct's upper bound `'literal'`, the other `'parameter'`; constraint `'mixed'`.
- `col < outer.x or col > 5` (in a correlated subquery or a join) → `'correlated'` on that bound, `correlated: true` on the constraint.
- `col < :lo + 1 or col > 5` → `'expression'` on that bound.
- All-literal ORs unchanged (`'literal'` everywhere).

A unit test in `constraint-extractor.spec.ts` over these shapes is enough. No seek emission changes: `rule-select-access-path`'s OR_RANGE arm already uses `valueExpr` when present.

## Reversibility

Additive fields plus a corrected label; a module that ignores them sees no change.
