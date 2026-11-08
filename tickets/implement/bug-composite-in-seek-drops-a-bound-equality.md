description: A lookup on a two-column key that combines a bound `=` with an `in (…)` list returned no rows. The one-line fix and its regression test are already in the working tree; what remains is confirming them on the store backend and handing off for review.
architecture: docs/optimizer-retrieve.md#access-path-selection
files: packages/quereus/src/planner/rules/access/rule-select-access-path.ts, packages/quereus/test/logic/07.9.1-in-value-list-composite-index.sqllogic
repro: verified
----

Filed from downstream: Optimystic (`@optimystic/quereus-plugin-optimystic`) avoids this shape and keeps its own blocked copy, `quereus-composite-in-seek-drops-a-bound-equality`, which unblocks once a Quereus release carries this fix.

## Reproduction (verified in the fix stage)

On a memory table with `create index t_ab on t(a, b)`, `select id from t where a = ? and b in ('p','q')` with `['x']` returned 0 rows instead of 2. The same happened for `a = ? and b in (?,?)` and `a in (?,?) and b = ?`. The all-literal form `a in ('x','y') and b = 'p'` was correct because it takes the plan-time literal path. The new cases appended to `test/logic/07.9.1-in-value-list-composite-index.sqllogic` failed at line 49 (`Row count mismatch. Expected 2, got 0`) before the fix.

## Cause

In the composite multi-seek arm of `selectPhysicalNodeFromPlan` (the `hasMultiValueIn && seekCols.length > 1` branch), a seek column with a single equality value kept its dynamic value expression only when that expression was an array. That is the shape a single-element `in (?)` produces. A plain `= ?` carries one scalar expression, so `exprs` was `undefined`, the dynamic cross-product built `Literal(undefined)` for that column, and the runtime's NULL-key skip dropped every seek tuple. `equalitySeekKey`, which serves the non-composite arm, already handled both shapes.

## Change (applied)

The single-value branch now wraps a scalar `valueExpr` in a one-element array:

```ts
exprs: c.valueExpr === undefined ? undefined : Array.isArray(c.valueExpr) ? c.valueExpr : [c.valueExpr],
```

`allLiteral` is already false for any constraint with a `valueExpr`, so these queries go through the existing dynamic cross-product unchanged. The comment above the branch was updated to name both shapes.

Regression test: six cases appended to `07.9.1-in-value-list-composite-index.sqllogic`, covering three parameterised forms and one all-literal control on a composite secondary index, plus two parameterised forms on a composite primary key. That file has `requires-capability: standalone-index-ddl`, so backends without `create index` skip it.

`yarn workspace @quereus/quereus test` after the change: 11107 passing, 26 pending, 0 failing.

## Edge cases & interactions

- A parameter bound to NULL in the `=` component (`a = ?` with `[null]`) must still return no rows. The runtime NULL-key skip now sees the real bound value instead of `undefined`. Verify by inspection, or with a one-off run; no new test needed.
- A correlated outer column as the `=` value (`a = outer.x and b in (…)` inside a subquery or nested-loop join) takes the same scalar-`valueExpr` shape, so the fix covers it. Verify by inspection.
- A mixed IN list (`b in ('p', ?)`) already carries an array `valueExpr` and goes through the unchanged multi-value branch. Unaffected.
- The `=` column can come first or second in the index. Both orders are covered by the new tests.

## TODO

- Run `yarn workspace @quereus/quereus test:store` (or the store run of just `07.9.1`) to confirm the store backend returns the same rows. The ticket reported the bug on store tables too.
- Run `yarn workspace @quereus/quereus lint`.
- Check whether `docs/optimizer-retrieve.md` (access-path selection, composite IN multi-seek) says anything about which value shapes the cross-product carries; update it only if it does.
