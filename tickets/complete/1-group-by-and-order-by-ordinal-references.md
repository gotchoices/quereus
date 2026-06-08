description: GROUP BY / ORDER BY 1-based ordinal SELECT-list references
prereq:
files:
  packages/quereus/src/planner/building/select-ordinal.ts
  packages/quereus/src/planner/building/select.ts
  packages/quereus/src/planner/building/select-aggregates.ts
  packages/quereus/src/planner/building/select-modifiers.ts
  packages/quereus/test/logic/07.3-group-by-extras.sqllogic
  packages/quereus/test/logic/28.2-orderby-expression-extras.sqllogic
  packages/quereus/test/logic/90.6-select-error-paths.sqllogic
  docs/sql.md
----

## What was built

`SELECT … GROUP BY N [, M…]` and `SELECT … ORDER BY N [, M…]` resolve a bare positive integer literal `N` as a 1-based reference into the SELECT list, using the AST expression that produced the Nth output column. Out-of-range / zero / negative ordinals raise a planning-time error with line/column info. Unary `+N` / `-N` (parsed as `UnaryExpr`) are also recognized so `order by -1` errors instead of silently sorting on the constant `-1`. Anything other than a bare integer literal (or `+/-N`) keeps current "constant expression" semantics — `group by 1 + 0` still produces a constant grouping key.

## Key files

- `packages/quereus/src/planner/building/select-ordinal.ts` (new): exports
  - `buildSelectListAsts(columns, input)` — builds a source-order array of AST expressions per output column, with `*` / `table.*` expanded against input attributes (synthetic `ColumnExpr` per attribute).
  - `resolveOrdinalReference(expr, selectListAsts, clauseName)` — returns the resolved AST when `expr` is an integer literal or `+/-` literal; throws `QuereusError` for out-of-range; returns `null` otherwise so the caller falls through to normal `buildExpression`.
- `packages/quereus/src/planner/building/select.ts`: builds `selectListAsts` once after star expansion and threads it into `buildAggregatePhase`, `buildFinalProjections`, `applyOrderBy` (early-aggregate, non-aggregate, and aggregate/window paths), and the inline pre-window sort branch.
- `packages/quereus/src/planner/building/select-aggregates.ts`: GROUP BY expressions resolve via the helper, then `buildExpression` runs in pre-aggregate scope; pre-aggregate ORDER BY sort also resolves.
- `packages/quereus/src/planner/building/select-modifiers.ts`: pre-projection ORDER BY and post-projection `applyOrderBy` both resolve.
- `docs/sql.md`: ORDER BY section now lists positional integer ordinals (parity with the existing GROUP BY bullet).

Returning the AST (rather than a pre-built `ScalarPlanNode`) lets each caller re-build the expression in whichever scope is current — important because aggregate ORDER BY runs against the post-aggregate scope (where an aggregate AST resolves to a `ColumnReferenceNode` against AggregateNode output) while GROUP BY runs against the pre-aggregate scope.

## Test coverage

- `packages/quereus/test/logic/07.3-group-by-extras.sqllogic` — single ordinal in GROUP BY + ORDER BY; multi-ordinal; ordinal + HAVING; ORDER BY ordinal `2` resolving to an aggregate output column.
- `packages/quereus/test/logic/28.2-orderby-expression-extras.sqllogic` — single ordinal; multi-ordinal mixed direction; ordinal resolving to an alias's expression.
- `packages/quereus/test/logic/90.6-select-error-paths.sqllogic` — `group by 0`, out-of-range `group by 2`, `order by -1` (UnaryExpr), out-of-range `order by 99`.

## Validation

- `yarn lint` (packages/quereus): clean.
- `yarn build` (full repo): clean.
- The three targeted sqllogic files all pass; window/group/order-by sqllogic suites pass with no regression.
- Manual edge cases verified: `select * from t order by 1` (star-expanded ordinal), `order by +1` (unary +), `order by 1 + 0` (falls through to constant expr), `order by 1` alongside window function.

Note: at HEAD the broader `yarn test` shows 6 failures in `optimizer/extended-constraint-pushdown.spec.ts` and `optimizer/predicate-normalizer.spec.ts`. These are unrelated — they all pass against this ticket's implement commit (`c6221346`) and were introduced by the later, separately-tracked ticket `1-group-by-preserves-projection-aliases` (still in its own `review/`).
