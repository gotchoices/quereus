description: Add inferReturnType to the four pass-through window functions — FIRST_VALUE, LAST_VALUE, LAG, LEAD — so they derive their result type from their value argument (argTypes[0]) instead of always reporting the fixed REAL. Mirrors the MIN/MAX window fix; plan-time only, no node/builder/runtime changes.
prereq: window-min-max-return-type-fidelity
files:
  - packages/quereus/src/func/builtins/builtin-window-functions.ts       # FIRST_VALUE/LAST_VALUE/LAG/LEAD registrations (lines ~61-112)
  - packages/quereus/src/schema/window-function.ts                       # WindowFunctionSchema.inferReturnType (already present)
  - packages/quereus/src/planner/nodes/window-function.ts                # consults inferReturnType when argTypes.length > 0 (already present)
  - packages/quereus/src/planner/building/expression.ts                  # builds windowArgTypes from all args (already present, ~line 238)
  - packages/quereus/test/planner/window-function-types.spec.ts          # add coverage
  - packages/quereus/test/logic/07.5-window.sqllogic                     # verify no snapshot diff
  - packages/quereus/test/logic/27-window-edge-cases.sqllogic            # verify no snapshot diff
difficulty: easy

# Window pass-through return-type fidelity (FIRST_VALUE / LAST_VALUE / LAG / LEAD)

## Problem

`window-min-max-return-type-fidelity` fixed the window forms of `MIN`/`MAX`,
which pass their argument value through unchanged but declared a fixed `REAL`
return type. It added an optional `inferReturnType(argTypes)` hook to
`WindowFunctionSchema`, threaded the built argument logical types into
`WindowFunctionCallNode.argTypes`, and made MIN/MAX derive `argTypes[0]`.

The same latent bug remains for the four other window functions that return
their argument value verbatim. All four register
`returnType: { logicalType: REAL_TYPE, nullable: true }` and have no
`inferReturnType`, so `first_value(text_col) over (...)` reports REAL at plan
time but yields TEXT at runtime:

- **`FIRST_VALUE(X)`** / **`LAST_VALUE(X)`** — `kind: 'value'`, `argCount: 1`.
- **`LAG(X [, offset [, default]])`** / **`LEAD(X [, offset [, default]])`** —
  `kind: 'navigation'`, `argCount: 'variadic'`. arg[0] is the value; arg[1] is
  the offset; arg[2] is the optional default.

`NTILE`, `ROW_NUMBER`, `RANK`, `DENSE_RANK`, `PERCENT_RANK`, `CUME_DIST` compute
numeric results and are correctly typed; `COUNT` is INTEGER; `SUM`/`AVG` apply
numeric coercion and stay REAL. Do **not** add `inferReturnType` to those — only
the four pass-through functions above.

## Design (resolved — no open questions)

All plumbing already exists and is fully generic:

- `WindowFunctionSchema.inferReturnType?: (argTypes) => ScalarType` is declared
  (`schema/window-function.ts:18`).
- `WindowFunctionCallNode` consults it whenever `argTypes.length > 0`
  (`planner/nodes/window-function.ts:42-44`), else falls back to `returnType`.
- The builder in `planner/building/expression.ts` (~line 238) builds
  `windowArgTypes` from **all** the call's args and threads them in. For
  variadic LAG/LEAD that array therefore contains the offset/default types too —
  so the hook must read **only `argTypes[0]`** and ignore the rest.

The fix is to copy the exact MIN/MAX pattern (`builtin-window-functions.ts:218-223`)
onto the four registrations:

```ts
inferReturnType: (argTypes) => ({
	typeClass: 'scalar',
	logicalType: argTypes[0],
	nullable: true,
	isReadOnly: true
}),
```

**LAG/LEAD with a differing-type `default` argument (decided):** keep
`argTypes[0]` (the value expression's type) and leave `nullable: true`. We do
**not** widen the type to accommodate a default of a different logical type. This
is the simplest correct rule: the result already tolerates NULL (out-of-range
rows yield NULL or the default), the value expression is the semantic source of
the column, and a mismatched default is an author concern, not a typing one.
Document this in a one-line comment on each LAG/LEAD registration.

**No runtime change required.** These four functions are dispatched through the
navigation/value code paths in `runtime/emit/window.ts`
(`computeNavigationFunction` / `computeValueFunction` and the streaming
`handleLag`/`handleLead`/value handlers), which evaluate the argument
expression on the target/frame row and return the raw `SqlValue`
(`exprCallback(rctx)`) — and return the default raw via `evalLagLeadDefault`.
Unlike MIN/MAX (whose `step`/`final` could float-coerce), there is no coercion
path to fix here. The change is purely plan-time typing.

## Edge cases & interactions

- **Variadic argTypes ordering (LAG/LEAD):** `argTypes` carries
  `[valueType, offsetType?, defaultType?]`. The hook must use `argTypes[0]`
  only — a test must prove `lag(v, 1)` over TEXT still types TEXT (offset
  INTEGER must not leak into the result type).
- **Differing-type default:** `lag(v, 1, 0)` where `v` is TEXT and the default
  is INTEGER `0` must still type as TEXT and run correctly (returns `0` for
  out-of-range rows under the chosen rule). Add a runtime smoke assertion.
- **Empty / out-of-range frame:** result stays `nullable: true`
  (`first_value`/`last_value` over an empty frame return NULL; LAG/LEAD past the
  partition edge return NULL or the default). Do not set `nullable: false`.
- **Expression argument (not bare column):** `first_value(id || '')` should type
  TEXT, proving the built expression's logical type flows through, not just a
  column ref — mirror the existing MIN expression-arg test.
- **Non-pass-through regression:** NTILE/ROW_NUMBER/RANK/SUM/COUNT must remain
  untouched even though `argTypes` now flows into their nodes (they have no
  `inferReturnType`, so they keep `returnType`). Assert this.
- **Surrounding-expression propagation:** the existing MIN test
  (`min(v) over () || '!'` types TEXT) exercises the `expression.ts` projection
  path. The same path serves these four — no new node coverage needed, but a
  parallel `first_value` assertion is cheap insurance.
- **sqllogic snapshots:** existing first_value/lag/lead cases over INTEGER
  columns in `07.5-window.sqllogic` and `27-window-edge-cases.sqllogic` already
  expect integer JSON; the REAL→INTEGER tightening should produce **no** diff.
  Verify (as the MIN/MAX change did) rather than assume.

## TODO

- Add `inferReturnType: (argTypes) => ({ typeClass: 'scalar', logicalType: argTypes[0], nullable: true, isReadOnly: true })` to the `FIRST_VALUE` and `LAST_VALUE` registrations in `builtin-window-functions.ts`, with a one-line comment noting the value pass-through (mirror the MIN/MAX comment).
- Add the same hook to `LAG` and `LEAD`, with a comment noting it uses `argTypes[0]` (the value arg) only — offset/default types are ignored, and a differing-type default does not widen the result.
- Add plan-time assertions to `test/planner/window-function-types.spec.ts` using the existing `getWindowFunctionTypesFromPlan` helper:
  - `first_value(v) over (order by id)` / `last_value(v) over (...)` over TEXT column `v` → TEXT.
  - `first_value(id) over (...)` / `last_value(id) over (...)` over INTEGER → INTEGER.
  - `lag(v) over (order by id)` / `lead(v) over (...)` over TEXT → TEXT; over INTEGER `id` → INTEGER.
  - `lag(v, 1)` over TEXT → TEXT (offset arg must not leak).
  - `first_value(id || '') over (...)` → TEXT (expression-arg path).
  - Regression: NTILE/ROW_NUMBER/SUM stay at their declared types (extend the existing "leaves non-polymorphic window functions" test or add a sibling).
- Add a runtime smoke assertion (using the existing `db.eval` one-row helper pattern) that `lag(v, 1, 'X') over (order by id)` over TEXT returns the prior `v` for in-range rows and `'X'` for the first row, and that a differing-type default — `lag(v, 1, 0)` over TEXT — types TEXT and returns `0` at the boundary.
- Run `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/win.log; tail -n 80 /tmp/win.log` and confirm the window sqllogic suites (`07.5-window`, `27-window-edge-cases`) show no snapshot diff.
- Run `yarn workspace @quereus/quereus lint` (single-quote globs on Windows) to catch any spec signature drift.
- No docs change expected (type-system behavior is already documented for MIN/MAX); skim `docs/types.md` for any window-function type table that enumerates these four and update if present.
