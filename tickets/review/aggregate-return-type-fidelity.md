----
description: Review aggregate return-type declarations fix — count(*)/count(x) → INTEGER not null; explicit types for sum/avg/total/group_concat/stat aggregates
files:
  - packages/quereus/src/func/builtins/aggregate.ts
  - packages/quereus/test/logic/51.7-maintained-table-attach-detach.sqllogic
  - packages/quereus/test/plan/aggregates/group-by.plan.json
----

# Aggregate return-type fidelity — review handoff

## What was done

### Phase 1 — aggregate.ts return types

Added `import { INTEGER_TYPE, REAL_TYPE, TEXT_TYPE } from '../../types/builtin-types.js'` and set explicit `returnType` on every affected aggregate:

| Function | returnType |
|---|---|
| `countStarFunc` | INTEGER not null |
| `countXFunc` | INTEGER not null |
| `sumFunc` | REAL nullable (was implicit default, now explicit) |
| `avgFunc` | REAL nullable (was implicit default, now explicit) |
| `totalFunc` | REAL not null (total() always returns 0.0) |
| `groupConcatFuncRev` | TEXT nullable |
| `varPopFunc` | REAL nullable (was implicit default, now explicit) |
| `varSampFunc` | REAL nullable (was implicit default, now explicit) |
| `stdDevPopFunc` | REAL nullable (was implicit default, now explicit) |
| `stdDevSampFunc` | REAL nullable (was implicit default, now explicit) |

`min`/`max` use `inferReturnType` — left untouched.

### Phase 2 — 51.7 test update

- Removed stale comment `(count(*) derives REAL nullable — the declared shape must say what the body derives, quirks included.)`
- Changed `create table counts (... n real null)` → `create table counts (... n integer not null)`

### Phase 3 — plan snapshot update

`packages/quereus/test/plan/aggregates/group-by.plan.json` had two `"resultType": "REAL"` entries for `COUNT()` and its downstream `employee_count` column reference. Both updated to `"INTEGER"`.

## Test results

All 5950 + 126 + 62 + 17 = 6155 tests pass, 0 failures.

## Known gaps / reviewer focus areas

- `count(DISTINCT x)` — uses the same numArgs:1 registration, so picks up INTEGER not null automatically. Not separately tested by a logic test; worth verifying in a sqllogic file.
- `count(*) over (...)` window form — already declared INTEGER not null in `builtin-window-functions.ts`; no change made, not re-verified here.
- `json_group_array` / `json_group_object` (json.ts) and `stringConcatFunc` (string.ts) still use implicit REAL nullable default — deferred to a follow-on ticket.
- Window function MIN/MAX in `builtin-window-functions.ts` use `REAL_TYPE` incorrectly (should follow arg type) — out of scope, parked in backlog.
- The `REAL_TYPE` fallback default in `createAggregateFunction` is intentionally left for third-party registrations that omit `returnType`.
