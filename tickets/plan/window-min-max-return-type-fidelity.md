----
description: Window MIN/MAX return type is hard-coded REAL nullable but should follow the argument type (like the aggregate min/max inferReturnType); needs inferReturnType support on the window-function schema
files:
  - packages/quereus/src/func/builtins/builtin-window-functions.ts   # MIN (~line 206) / MAX (~line 227)
  - packages/quereus/src/func/builtins/aggregate.ts                  # minFunc/maxFunc — the correct inferReturnType pattern to mirror
  - packages/quereus/src/schema/function.ts                          # WindowFunctionSchema — may need an inferReturnType field
difficulty: medium
----

# Window MIN/MAX return-type fidelity

The window forms of `MIN`/`MAX` in `builtin-window-functions.ts` declare a fixed
`returnType` of `REAL_TYPE` nullable, but their `step`/`final` pass the argument
value through unchanged (`state = value`). So `min(text_col) over (...)` returns
TEXT at runtime while the planner derives REAL — a type-fidelity bug, the
window-frame analogue of the aggregate `min`/`max` case.

The non-window aggregate `minFunc`/`maxFunc` (`aggregate.ts:90`/`114`) already
do this correctly via `inferReturnType: (argTypes) => ({ ...logicalType:
argTypes[0], nullable: true })`. The window versions should mirror that.

## Why this is medium, not trivial

The aggregate path supports `inferReturnType` on `AggregateFunctionSchema`, and
`AggregateFunctionCallNode.getType()` consults it. The window-function
registration path (`registerWindowFunction` / `WindowFunctionSchema`) needs to
be checked for equivalent `inferReturnType` support — the parent ticket's
handoff stated the window schema "lacks `inferReturnType` support." If so, this
ticket must:

1. Add an optional `inferReturnType` to the window-function schema.
2. Thread it through wherever the window node computes its output type
   (mirror `aggregate-function.ts` `getType()`).
3. Set `inferReturnType` on window `MIN`/`MAX` to follow `argTypes[0]`.

## Acceptance

- `min(text_col) over (...)` / `max(text_col) over (...)` derive the argument's
  type, not REAL — pinned by a plan snapshot or a type-asserting logic test.
- Numeric `min/max over` still derive their numeric arg type.
- `yarn workspace @quereus/quereus run lint` and `... run test` green.
