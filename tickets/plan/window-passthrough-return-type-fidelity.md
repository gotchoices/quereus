description: Extend window return-type fidelity to the other pass-through window functions — FIRST_VALUE, LAST_VALUE, LAG, LEAD all declare a fixed REAL return type but emit their argument value unchanged at runtime, so first_value(text_col) over (...) reports REAL at plan time and TEXT at runtime. The inferReturnType plumbing landed by window-min-max-return-type-fidelity is already in place; these functions just need to opt in.
prereq: window-min-max-return-type-fidelity
files:
  - packages/quereus/src/func/builtins/builtin-window-functions.ts       # FIRST_VALUE/LAST_VALUE/LAG/LEAD registrations
  - packages/quereus/src/schema/window-function.ts                       # WindowFunctionSchema.inferReturnType (already added)
  - packages/quereus/src/planner/nodes/window-function.ts                # consults inferReturnType (already added)
  - packages/quereus/test/planner/window-function-types.spec.ts          # add coverage
difficulty: medium

# Window pass-through return-type fidelity (FIRST_VALUE / LAST_VALUE / LAG / LEAD)

## Problem

`window-min-max-return-type-fidelity` fixed the window forms of `MIN`/`MAX`: they
pass their argument value through unchanged but declared a fixed `REAL` return
type, so `min(text_col) over (...)` mis-typed as REAL at plan time. The fix added
an optional `inferReturnType(argTypes)` hook to `WindowFunctionSchema`, threaded
the built argument logical types into `WindowFunctionCallNode`, and made MIN/MAX
derive their argument's type.

The **same latent bug remains** for every other window function that returns its
argument value verbatim:

- **`FIRST_VALUE(X)`** / **`LAST_VALUE(X)`** — return X's value; declared REAL.
- **`LAG(X [, offset [, default]])`** / **`LEAD(X [, offset [, default]])`** —
  return X's value (or the default); declared REAL.

All four currently register `returnType: { logicalType: REAL_TYPE, nullable: true }`
in `builtin-window-functions.ts`. `first_value(name_col) over (...)` reports REAL
at plan time but yields TEXT at runtime — identical to the MIN/MAX bug.

`NTILE`, `ROW_NUMBER`, `RANK`, `DENSE_RANK`, `PERCENT_RANK`, `CUME_DIST` compute a
numeric result and are correctly typed; `COUNT` is INTEGER; `SUM`/`AVG` apply
numeric coercion and stay REAL. **Do not** add `inferReturnType` to those — only
the value/navigation pass-through functions.

## Expected behavior

- `first_value(v) over (...)` / `last_value(v) over (...)` where `v` is TEXT →
  derive TEXT; over an INTEGER column → INTEGER; over an expression argument →
  that expression's logical type. Mirror MIN/MAX exactly (argTypes[0], the result
  remains nullable — the frame may be empty / value may be NULL).

- `lag(v) over (...)` / `lead(v) over (...)` → derive from `argTypes[0]` (the
  value argument is the first arg). These are `argCount: 'variadic'`:
  - arg[0] is the value expression — the result type follows it.
  - arg[1] (offset) and arg[2] (default), when present, must NOT be mistaken for
    the value type. Use `argTypes[0]` only.
  - Result stays nullable (out-of-range rows yield NULL or the default). Decide
    whether a supplied default of a different logical type should widen the type;
    simplest correct behavior is to keep `argTypes[0]` and leave nullable=true.
    Document the choice.

## Notes / acceptance

- The `inferReturnType` hook and the `WindowFunctionCallNode.argTypes` plumbing
  already exist — this is purely adding the hook to four registrations plus tests.
  No node/builder changes expected.
- Add plan-time type assertions to `test/planner/window-function-types.spec.ts`
  (same `getWindowFunctionTypesFromPlan` helper) for first_value/last_value/lag/
  lead over TEXT and INTEGER, plus a regression that NTILE/ROW_NUMBER/SUM are
  untouched.
- Confirm the sqllogic suites (`test/logic/07.5-window.sqllogic`,
  `27-window-edge-cases.sqllogic`) still pass — existing first_value/lag/lead
  cases over INTEGER columns already expect integer JSON, so the REAL→INTEGER
  tightening should produce no snapshot diff (verify, as the MIN/MAX change did).
- Verify LAG/LEAD with an explicit `default` argument of a differing type still
  types and runs correctly under the chosen rule.
