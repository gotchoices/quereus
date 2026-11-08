description: A lookup on a two-column key that combined a bound `=` with an `in (…)` list returned no rows; a planner fix now makes it return the right rows on both the memory and store backends.
architecture: docs/optimizer-retrieve.md#access-path-selection
files: packages/quereus/src/planner/rules/access/rule-select-access-path.ts, packages/quereus/test/logic/07.9.1-in-value-list-composite-index.sqllogic, docs/memory-table.md
repro: verified
----

Filed from downstream: Optimystic (`@optimystic/quereus-plugin-optimystic`) avoids this query shape and keeps its own blocked copy, `quereus-composite-in-seek-drops-a-bound-equality`, which unblocks once a Quereus release carries this fix.

## What was wrong

On `create index t_ab on t(a, b)`, `select id from t where a = ? and b in ('p','q')` with `['x']` returned 0 rows instead of 2. `a = ? and b in (?,?)` and `a in (?,?) and b = ?` failed the same way. The all-literal form was correct because it is resolved at plan time.

The composite multi-seek arm of `selectPhysicalNodeFromPlan` (`rule-select-access-path.ts`, the `hasMultiValueIn && seekCols.length > 1` branch) built the seek value for a single-value column by hand. It kept the dynamic value expression only when it was an array (the shape a single-element `in (?)` produces). A plain `= ?` or a correlated `= o.x` carries one scalar expression, so the column fell back to `Literal(undefined)`, and the runtime's skip for NULL-bearing seek keys dropped every seek tuple.

## Change

- Fix stage (`ticket(fix): bug-composite-in-seek-drops-a-bound-equality`): wrapped a scalar `valueExpr` in a one-element array, and added six regression cases to `07.9.1-in-value-list-composite-index.sqllogic` (bound `=` on the first and second column, with literal and bound `IN` lists, on a composite secondary index and a composite primary key, plus an all-literal control).
- Implement stage: `docs/memory-table.md` ("Advanced Query Planning") now says the composite multi-seek is a cross-product of the `IN` lists and `=` values, literal or bound.
- Review stage: replaced the hand-rolled shape dispatch with a call to `equalitySeekKey`, the helper every other equality seek in the rule already uses (single-column point seek, composite point seek, prefix-equality + trailing range). There is now one place that maps an equality constraint's value shapes to a seek key, so a new shape cannot be handled in one seek path and missed in another.

## Review findings

- **Correctness of the fix:** confirmed. For a single-value column, `equalitySeekKey` returns the single-element `IN` expression, the scalar `=` / correlated expression, or a literal typed from the column — the last being exactly what the dynamic cross-product path's own fallback built. The all-literal path still reads only `values`, so its plan-time NULL/duplicate reduction is unchanged.
- **Multi-element `IN` with a scalar `valueExpr` (the implementer's open question):** cannot occur. Both producers of a multi-element `IN` constraint — `extractInConstraint` and `collapseBranchesToIn` in `planner/analysis/constraint-extractor.ts` — set `valueExpr` to an array or leave it undefined. The multi-value arm's `Array.isArray(c.valueExpr) ? c.valueExpr : undefined` is correct as written.
- **Same bug class elsewhere:** checked every `valueExpr` shape dispatch in `src/planner`. All other equality seek sites already went through `equalitySeekKey`. Range-bound sites (`lower`/`upper.valueExpr`) only ever see scalar expressions, since range constraints never come from `IN`. `change-scope.ts` (`scopeValuesForColumn` area, ~line 672) handles both shapes. No other instance.
- **Correlated `=` value untested at the composite multi-seek:** now covered by construction, because the composite arm calls the same `equalitySeekKey` the single-column correlated seeks use. No test added — forcing that plan needs a large table purely to win the cost comparison, and it would test the shared helper again.
- **Tests:** the six fix-stage cases are reproductions of this bug on both index kinds; kept. None cut.
- **Docs:** `docs/memory-table.md` updated correctly; `docs/optimizer-retrieve.md` and `docs/module-authoring.md` say nothing about value shapes and need no change; `docs/optimizer-rule-families.md:152` already describes `valueExpr` as scalar or array.
- **Hygiene:** the replaced comment narrated the shape dispatch; the new one states why the helper is used (the earlier divergence). No size concerns from a one-line change.
- **Tripwires / tickets filed:** none — nothing conditional or out of scope surfaced.
- **Validation:** `yarn workspace @quereus/quereus lint` exits 0; `yarn workspace @quereus/quereus test` 11107 passing, 26 pending, 0 failing; `yarn workspace @quereus/quereus test:store --grep "07.9"` 3 passing.
