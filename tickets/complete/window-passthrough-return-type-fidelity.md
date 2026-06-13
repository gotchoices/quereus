description: Window pass-through functions (FIRST_VALUE, LAST_VALUE, LAG, LEAD) derive return type from their value argument instead of a fixed REAL.
files:
  - packages/quereus/src/func/builtins/builtin-window-functions.ts
  - packages/quereus/test/planner/window-function-types.spec.ts
  - docs/window-functions.md

# Window pass-through return-type fidelity — completed

## What shipped

`FIRST_VALUE`, `LAST_VALUE`, `LAG`, and `LEAD` now report a plan-time return
type derived from their value argument (`argTypes[0]`) rather than the fixed
`REAL` fallback, mirroring the `MIN`/`MAX` window pattern landed by the prereq
(`window-min-max-return-type-fidelity`). The planner plumbing
(`WindowFunctionCallNode.argTypes`, threaded in both `select-window.ts` and the
expression-tree path in `expression.ts`) was already generic from the prereq, so
no node/builder/runtime changes were needed.

The runtime already emits these values verbatim (no float coercion) on both the
buffered path (`computeNavigationFunction`, `computeValueFunction`) and the
streaming fast path (`fillLag`/`handleLead`/firstValue/lastValue slot fills in
`runStreaming`), so the tightened declared type now matches actual runtime
values — verified by runtime smoke tests.

## Review findings

Reviewed the implement diff (`e98c4ce7`) with fresh eyes, then the runtime,
planner construction sites, schema, and docs.

### Type safety / correctness — checked, sound
- Confirmed `inferReturnType` is only invoked when `argTypes.length > 0`
  (`window-function.ts:45`), so `argTypes[0]` is never undefined at the call
  site. The `'variadic'` arg-count looseness on LAG/LEAD (accepts any arity) is
  pre-existing and unrelated to this ticket.
- Confirmed both buffered and streaming runtime paths return the raw argument
  value, so the new plan type (e.g. TEXT) cannot diverge from the emitted value.
  This was the key risk and it holds.
- LAG/LEAD with a mismatched-type default (e.g. `lag(v,1,0)` over TEXT) returns
  the raw default at the boundary — matches the decided design (value arg drives
  the type; mismatched default is the author's concern).

### DRY — finding, fixed inline (minor)
The pass-through `inferReturnType` lambda was duplicated **six** times (MIN, MAX,
LAG, LEAD, FIRST_VALUE, LAST_VALUE) — a direct violation of the repo's DRY
guideline. Extracted a single shared `passThroughArgType` helper at the top of
`builtin-window-functions.ts` and pointed all six registrations at it (including
the two MIN/MAX sites from the prereq). Net behavior identical; lint + tests green.

### Test coverage — finding, fixed inline (minor)
The implementer flagged an asymmetry: LAG had a runtime smoke but FIRST_VALUE/
LAST_VALUE were plan-type-only. Added a runtime smoke asserting
`first_value(v)`/`last_value(v)` over TEXT preserve the string values across the
default frame (`['a','a','a']` / `['a','b','c']`). The FIRST_VALUE expression-arg
test and the LAG offset/default-leak tests from the implementer remain and cover
the expression-flow and offset-isolation paths; the prereq's MIN test already
pins the surrounding-expression (`expression.ts`) path, so it was not duplicated
per-function.

### Documentation — finding, fixed inline (minor)
`docs/window-functions.md` § Extensibility carried a stale `registerWindowFunction`
example (wrong two-argument signature, nonexistent `init` field) that predates
this ticket and was never corrected by the MIN/MAX prereq. Since return-type
inference is exactly what this section should describe, corrected the example to
the real single-schema-object API and documented the optional
`inferReturnType(argTypes)` pattern for pass-through functions.

### Out of scope / no action
- The `'variadic'` arg-count on LAG/LEAD does not enforce the 1–3 argument
  bound; this is pre-existing and not introduced here. Not filed — low value and
  the parser/validation layer is a separate concern.

## Validation
- `yarn workspace @quereus/quereus lint`: exit 0 (eslint + test-file typecheck).
- `yarn workspace @quereus/quereus test`: **6146 passing, 9 pending, 0 failing**
  (was 6145; +1 from the new FIRST_VALUE/LAST_VALUE runtime smoke).
- No pre-existing failures encountered.
