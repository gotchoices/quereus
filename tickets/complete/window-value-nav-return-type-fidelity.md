description: FIRST_VALUE / LAST_VALUE / LAG / LEAD window return-type fidelity — superseded by window-passthrough-return-type-fidelity, which shipped the identical work.
files:
  - packages/quereus/src/func/builtins/builtin-window-functions.ts
  - packages/quereus/src/planner/nodes/window-function.ts
  - packages/quereus/test/planner/window-function-types.spec.ts

# Window value/navigation return-type fidelity — superseded (no work needed)

## Resolution

This plan ticket is a **duplicate** of `window-passthrough-return-type-fidelity`
(in `tickets/complete/`), which was planned, implemented, and reviewed after this
ticket was filed and shipped the exact change this ticket scopes. No additional
plan or implement ticket is warranted — dispatching one would re-do
already-reviewed, already-committed work.

Both tickets share the same root cause (the same one fixed for window MIN/MAX in
the `window-min-max-return-type-fidelity` prereq) and cover the same four
functions: `FIRST_VALUE`, `LAST_VALUE`, `LAG`, `LEAD`.

## What already shipped (commits e98c4ce7 implement, 4daf1169 review)

- All four schemas in `builtin-window-functions.ts` now carry
  `inferReturnType: passThroughArgType` — a single shared helper (extracted
  during the passthrough review) that returns `{ logicalType: argTypes[0],
  nullable: true }`. The fixed `REAL` `returnType` remains only as the
  no-arg-types fallback. MIN/MAX were repointed at the same helper, so the
  pass-through lambda exists once, not six times.
- The planner plumbing was already generic from the MIN/MAX prereq:
  `WindowFunctionCallNode.argTypes` (`planner/nodes/window-function.ts:35`) is
  consulted by the `outputTypeCache` (`:45`) and threaded in by both the
  `select-window.ts` builder and the expression-tree path in `expression.ts`.
  No node/builder/runtime changes were needed.
- Runtime already emits these values verbatim on both the buffered path
  (`computeNavigationFunction` / `computeValueFunction`) and the streaming fast
  path (`fillLag` / `handleLead` / first/last slot fills in `runStreaming`), so
  the tightened declared type matches the emitted value with no float coercion.

## Design question — resolved

The open question this ticket raised (LAG/LEAD default-arg typing: use
`argTypes[0]` only, vs. a common type of value + default) was settled as
**option (a)**: the value argument drives the result type; a mismatched explicit
`default` (e.g. `lag(int_col, 1, 'n/a')`) returns the raw default at the boundary
and is the author's concern. This matches SQLite's behavior and avoids widening
the declared type off the value column. The offset argument (`argTypes[1]`)
never participates.

## Test coverage already present

`packages/quereus/test/planner/window-function-types.spec.ts` covers all four
functions:
- FIRST_VALUE/LAST_VALUE: plan-time TEXT and INTEGER derivation, expression-arg
  derivation (`first_value(id || '')` → TEXT), and a runtime smoke asserting
  TEXT values survive the default frame (`['a','a','a']` / `['a','b','c']`).
- LAG/LEAD: plan-time TEXT and INTEGER derivation, offset-leak isolation
  (`lag(v, 1)` stays TEXT), and a runtime smoke confirming a differing-type
  default (`lag(v, 1, 'X')` and `lag(v, 1, 0)`) types as the value argument and
  returns the raw default at the boundary.

Validation at the time of the passthrough ticket: lint exit 0; `yarn workspace
@quereus/quereus test` 6146 passing / 9 pending / 0 failing.

## No backlog remainder

The only deferred note from the passthrough review — that `'variadic'` arg-count
on LAG/LEAD does not enforce the 1–3 argument bound — is pre-existing,
unrelated to return-type fidelity, and was deliberately not filed (low value;
parser/validation is a separate concern). Nothing further to park.
