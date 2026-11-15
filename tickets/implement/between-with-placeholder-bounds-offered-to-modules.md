description: A query such as "x between ? and ?" never offers its bounds to the storage module, because the engine only turns BETWEEN into index bounds when both ends are literal values. Offer it exactly the way "x >= ? and x <= ?" is offered, so indexes (including lamina's multi-dimensional box lookup) can seek on it.
architecture: docs/module-authoring.md
files:
  - packages/quereus/src/planner/analysis/constraint-extractor.ts   # extractBetweenConstraints (literal-only gate, ~line 503); extractBinaryConstraint (value-side classification to factor out, ~lines 440-481); isDynamicValue, unwrapCastForBindingKind, bindingReferencesOuterTable
  - packages/quereus/test/planner/constraint-extractor.spec.ts      # describe('extractBetweenConstraints') ~line 334; paramRef helper ~line 70
  - packages/quereus/test/vtab/module-seek-filters.spec.ts           # box test (~line 67) spelled with comparisons; switch to between
  - packages/quereus/test/vtab/null-bound-seek.spec.ts               # already has 'id BETWEEN ? AND 5' — becomes a seek after this change, so it pins the run-time NULL bound
  - packages/quereus/test/json-parameter-equality.spec.ts            # 'applies the same coercion to BETWEEN bounds' — must still pass
  - packages/quereus/test/parameter-array-scalar.spec.ts             # 'name between ? and ?' array-bind mismatch — must still pass
  - docs/module-authoring.md                                         # "Module-listed seek arguments", ~line 393: sentence saying between ? and ? is not offered
----
# Offer BETWEEN with placeholder or correlated bounds to modules

## Current behaviour

`extractBetweenConstraints` (`constraint-extractor.ts`) returns null unless both bounds are plan-time literals. `where x between ? and ?` therefore reaches `getBestAccessPlan` with no filter on `x` and stays a residual `Filter` above a full scan. The comparison spelling `x >= ? and x <= ?` goes through `extractBinaryConstraint`, which yields two constraints with `valueExpr` set and `bindingKind: 'parameter'`, and every module can seek them.

Everything downstream of the extractor already handles a range constraint with a run-time value, because the comparison spelling produces them today:

- `rangeSeekKey` (rule-select-access-path.ts) uses `valueExpr` when present.
- `branchToRangeSpec` / `tryCollapseToOrRange` carry `valueExpr`/`bindingKind`/`correlated` into OR_RANGE bounds, and the multi-range seek reads `range.lower.valueExpr`.
- Two constraints sharing one BETWEEN node as `sourceExpression` is already the literal-BETWEEN shape: `combineResidualExpressions` de-duplicates by identity, `rule-grow-retrieve` keys roles on (sourceExpression, columnIndex, op), and `orBranchConstraintCollationOk` has a `BetweenNode` arm.
- A run-time NULL range bound matches nothing (`null-bound-seek.spec.ts`).

So the change is confined to the extractor.

## Design

Factor the value-side classification out of `extractBinaryConstraint` into one helper both paths call, so BETWEEN cannot drift from the comparison path:

```ts
/** Value-side binding of a constraint; null when the value reads the constrained table's own row (never a seek key). */
type ValueBinding = Pick<PredicateConstraint, 'value' | 'valueExpr' | 'bindingKind' | 'correlated'>;
function classifyValueBinding(valueSide: ScalarPlanNode, tableInfo: TableInfo): ValueBinding | null;
```

- Literal (`isLiteralConstant`): `{ value: getLiteralValue(side), bindingKind: 'literal' }`.
- Otherwise: `valueExpr: valueSide` (cast retained), `bindingKind` from `unwrapCastForBindingKind(valueSide)` — `'parameter'` for a `ParameterReference`, `'correlated'` for a `ColumnReference` of another table, null for a same-table `ColumnReference`, else `'expression'` — and `correlated: bindingReferencesOuterTable(valueSide, tableInfo)`. This is the existing body of `extractBinaryConstraint` lines ~440-481, moved verbatim.

`extractBinaryConstraint` calls it for its value side and spreads the result into its constraint; behaviour unchanged (its `bindingKind: 'literal'` when both sides are literal still comes out the same, since the value side is then literal).

`extractBetweenConstraints`:

- Keep: column operand must be a column reference; NOT BETWEEN → null; table/column mapping lookups.
- Replace the literal-only gate with: each bound must satisfy `isLiteralConstant(b) || isDynamicValue(b)` — the same acceptance test `extractBinaryConstraint` applies to its value side. Note this means a bound that is an arbitrary expression such as `? + 1` stays residual, exactly as `x >= ? + 1` does today; widening that is out of scope for both spellings.
- A literal NULL bound → null (whole BETWEEN residual), unchanged.
- Classify each bound with `classifyValueBinding`; either returning null (same-table column) → null, whole BETWEEN residual.
- Emit the `>=` and `<=` constraints as today, spreading each bound's binding, `sourceExpression: expr` for both, `collation: effectiveBetweenBoundCollation(col, bound)` per bound.
- Update the "Only support column BETWEEN literal AND literal" comment.

Mixed bounds (`x between 1 and ?`) yield one literal and one parameter constraint.

## Edge cases & interactions

- Same-table bound (`a between b and 20`, b on the same table): whole BETWEEN residual. Verified by the existing unit test 'BETWEEN with non-literal bounds → residual' (its `col2` is TABLE_A's own column) — keep it, retitle to say same-table.
- Literal NULL bound: residual, unchanged — by inspection.
- Run-time NULL bound: no rows. Verified by the existing `null-bound-seek.spec.ts` case `id BETWEEN ? AND 5`, which becomes a real seek with this change (today it passes via the residual filter).
- Converting cast around a bound (e.g. JSON-column bounds coerced by the builder): `isDynamicValue`/`unwrapCastForBindingKind` look through it while `valueExpr` keeps the cast, same as the comparison path. Verified by `json-parameter-equality.spec.ts` 'applies the same coercion to BETWEEN bounds' continuing to pass.
- Converting cast around the tested column (`cast(x as integer) between 1 and 1`): `isColumnReference` only sees through no-op casts, so it stays residual — `test/plan/cast-seek-blocking.spec.ts` pins it.
- Array bound to a scalar placeholder: rejected at bind time by `scalar-param-usage.ts` (already walks `BetweenNode`), verified by `parameter-array-scalar.spec.ts`.
- Correlated bound (`x between o.lo and o.hi` inside a correlated subquery): becomes a correlated range seek with `correlated: true`; the `IndexSeekNode` row-context assertion (`assertSeekKeysRowIndependent`, OPT-061) and index-nested-loop's gate on `c.correlated` already govern this for the comparison spelling — by inspection.
- OR of BETWEENs with placeholders (`x between ? and ? or x between ? and ?`): now collapses to OR_RANGE with dynamic bounds via the existing `tryCollapseToOrRange`; the collation gate's `BetweenNode` arm applies — by inspection; the full test suite exercises OR_RANGE with dynamic comparison bounds already.
- A module consumes only one half: the unconsumed half reattaches as the whole BETWEEN (identity de-dup), which is correct because the consumed half is implied — by inspection, already true for literal BETWEEN.
- Plan-shape changes: memory and store plans for `between ?` change from scan + filter to range seek. Look for plan tests or snapshots that pin the old shape (`grep -rn -i "between ?\|between :" packages/quereus/test`); at plan time only `json-parameter-equality` and `parameter-array-scalar` matched, both result-only. Also run `yarn test:store` if time allows, since the store module now receives these filters.

## Tests

Only these; everything else is covered by existing tests listed above.

- `constraint-extractor.spec.ts`, in `describe('extractBetweenConstraints')`: one test for `a between :lo and :hi` (use `paramRef`) asserting two constraints, ops `>=`/`<=`, each `bindingKind: 'parameter'`, `valueExpr` the respective parameter node, `correlated: false`, both `sourceExpression === expr`. One test for mixed `a between 1 and :hi` asserting the `>=` half is literal with `value` 1 and no `valueExpr`, the `<=` half parameter. One test for an outer-table bound (`a between x and 20` with `x` from TABLE_B, TABLE_A only in the map — check how existing correlated tests set this up, e.g. around line 438) asserting `bindingKind: 'correlated'`, `correlated: true`.
- `module-seek-filters.spec.ts` box test: switch the SQL to `x between ? and ? and y between ? and ?` and drop the comment saying between is not offered yet; its assertions on the listed constraints and arguments should hold unchanged (filter order x>=, x<=, y>=, y<=).

## TODO

- Factor `classifyValueBinding` out of `extractBinaryConstraint`; make `extractBinaryConstraint` use it.
- Rewrite `extractBetweenConstraints`'s bound gate and constraint construction as above.
- Add the three extractor unit tests; retitle the same-table test.
- Switch the module-seek-filters box test to the between spelling.
- Update `docs/module-authoring.md` ~line 393: say a BETWEEN reaches the module as its two bounds when each bound is a literal, a placeholder, or an outer column (the same values a comparison accepts); drop "spell placeholder bounds with comparisons".
- `yarn workspace @quereus/quereus run lint` and `yarn test`; fix any plan-shape test that pinned the old scan + filter shape for a placeholder BETWEEN (update it to the seek shape — it is an intended change).
