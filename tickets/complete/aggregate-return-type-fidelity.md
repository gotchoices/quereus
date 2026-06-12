----
description: Aggregate return-type declarations — count(*)/count(x) → INTEGER not null; explicit types for sum/avg/total/group_concat/stat aggregates
files:
  - packages/quereus/src/func/builtins/aggregate.ts
  - packages/quereus/test/logic/51.7-maintained-table-attach-detach.sqllogic
  - packages/quereus/test/plan/aggregates/group-by.plan.json
----

# Aggregate return-type fidelity — complete

## Summary

`createAggregateFunction` defaults `returnType` to `REAL nullable` when a
registration omits it. `count(*)`/`count(x)` omitted it, so the planner derived
them as `REAL nullable` despite count always returning a non-null integer; the
maintained-table strict-shape check surfaced this. Fixed by setting explicit
`returnType` on the affected builtin aggregates:

| Function | returnType |
|---|---|
| `countStarFunc`, `countXFunc` | INTEGER not null |
| `totalFunc` | REAL not null (`total()` always returns 0.0) |
| `groupConcatFuncRev` | TEXT nullable |
| `sumFunc`, `avgFunc`, `varPopFunc`, `varSampFunc`, `stdDevPopFunc`, `stdDevSampFunc` | REAL nullable (was the implicit default, now explicit/documented) |

`min`/`max` already use `inferReturnType` (follow arg type) — untouched.
Test updates: `51.7` maintained-attach case now declares `n integer not null`
(was `n real null` to match the old wrong derivation); `group-by.plan.json`
COUNT + downstream `employee_count` snapshots flipped REAL → INTEGER.

## Review findings

### Verified correct (no change needed)

- **Type/schema shape.** `returnType` literals match `ScalarType`
  (`{typeClass:'scalar', logicalType, nullable, isReadOnly}`); `INTEGER_TYPE`/
  `REAL_TYPE`/`TEXT_TYPE` import resolves. `AggregateFunctionCallNode.getType()`
  returns `schema.returnType` when no `inferReturnType` — so the declared types
  take effect, and `isDistinct` does not alter type derivation (the same code
  path serves `count(distinct x)`).
- **Plan snapshots.** `group-by.plan.json` was the only snapshot with a COUNT
  `resultType`; both COUNT and the `employee_count` column-ref were updated. The
  other `resultType: REAL` entries across the plan snapshots are `AVG` (correct)
  and numeric literals (`25`/`30`) — correctly left alone.
- **Maintained-table tests.** `51.7` is the only maintained-table test using an
  aggregate body; all other `set maintained` cases select plain columns. The
  comment edit reads coherently and the test is now a *stronger* regression net
  (it positively asserts the shape check passes with the correct declared type).
- **Docs.** No doc states aggregate return types as REAL. `materialized-views.md`
  references count(*) NULL semantics for avg-decomposition — consistent with the
  INTEGER not-null change, not stale.
- **Lint + tests.** `yarn workspace @quereus/quereus run lint` clean;
  `... run test` → 5950 passing, 9 pending, 0 failures.

### count(distinct x) type (handoff "reviewer focus")

Checked, no test added. The distinct path shares the identical type-derivation
code (`getType()` → `schema.returnType`; `isDistinct` is irrelevant to type),
already exercised by the count(*)/count(x) coverage (51.7 + plan snapshot). A
maintained-table assertion (the only direct declared-type vehicle) is not usable
here: DISTINCT aggregates do not compose for incremental maintenance. Marginal
value did not justify a fragile bespoke test.

### Major — deferred work was claimed parked but no tickets existed (FILED)

The handoff stated json_group_*/string_concat were "deferred to a follow-on
ticket" and window MIN/MAX "parked in backlog" — but **no such tickets
existed**. Filed two backlog tickets so the deferrals are real:

- `backlog/aggregate-return-type-fidelity-json-string` — `json_group_array`/
  `json_group_object` → JSON nullable, `string_concat` → TEXT nullable. These are
  the only remaining builtin aggregates on the implicit REAL-nullable default
  (confirmed by a full `createAggregateFunction` inventory). Kept out of this
  pass: the JSON ones need an end-to-end serialize/round-trip verification, not a
  one-liner.
- `backlog/window-min-max-return-type-fidelity` — window `MIN`/`MAX` hard-code
  REAL but pass the arg value through unchanged; should follow arg type like the
  aggregate `min`/`max`. Needs `inferReturnType` support on the window schema —
  genuinely out of scope.

The `REAL_TYPE` fallback in `createAggregateFunction` is intentionally retained
for third-party registrations that omit `returnType`.

### Not found

No correctness bugs, no SPP/DRY/cleanup issues in the diff (the change is purely
additive metadata literals). No resource-cleanup or error-handling surface.
