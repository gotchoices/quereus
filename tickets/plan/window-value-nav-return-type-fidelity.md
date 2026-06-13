----
description: FIRST_VALUE / LAST_VALUE / LAG / LEAD window functions hard-code REAL nullable return type but pass their argument value through unchanged; they should follow the argument type, same bug class as window MIN/MAX
prereq: window-min-max-return-type-fidelity
files:
  - packages/quereus/src/func/builtins/builtin-window-functions.ts   # LAG (~62) / LEAD (~75) / FIRST_VALUE (~89) / LAST_VALUE (~102)
  - packages/quereus/src/planner/nodes/window-function.ts            # inferReturnType plumbing landed by the MIN/MAX ticket
----

# Window value/navigation return-type fidelity

`FIRST_VALUE`, `LAST_VALUE`, `LAG`, and `LEAD` in
`builtin-window-functions.ts` all declare a fixed `returnType` of `REAL_TYPE`
nullable, but each returns its argument value (or a default) unchanged. So
`first_value(text_col) over (...)`, `lag(text_col) over (...)`, etc. return TEXT
at runtime while the planner derives REAL — the same type-fidelity bug fixed for
window `MIN`/`MAX` in `window-min-max-return-type-fidelity`.

Once that ticket lands the `inferReturnType` plumbing on `WindowFunctionSchema`
and threads argument types into `WindowFunctionCallNode`, this becomes a small
follow-up: add `inferReturnType` to each of these four schemas to follow
`argTypes[0]`.

## Nuance to resolve during planning

- **`FIRST_VALUE` / `LAST_VALUE`** are clean single-argument pass-throughs —
  `logicalType: argTypes[0]`, nullable true. Straightforward.
- **`LAG` / `LEAD`** are `variadic` (`lag(expr, offset?, default?)`). The result
  is `expr`'s type, but an explicit `default` argument can be a different type
  (e.g. `lag(int_col, 1, 'n/a')`). Decide whether to (a) use `argTypes[0]` only,
  or (b) compute a common type of `argTypes[0]` and the default's type
  (`argTypes[2]` when present), mirroring how `coalesce`/`iif` find a common
  type. SQLite's behavior and the existing `findCommonType` helper
  (`func/builtins/scalar.ts`) are the references.

## Why backlog, not implement

The MIN/MAX ticket is scoped to MIN/MAX plus the schema/threading
infrastructure. This is genuinely adjacent (same root cause) but carries its own
open design question (LAG/LEAD default-arg typing) that should be resolved in a
planning pass rather than bolted onto the MIN/MAX implement ticket.
