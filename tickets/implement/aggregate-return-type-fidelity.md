----
description: Fix aggregate return-type declarations — count(*)/count(x) → INTEGER not null; explicit types for sum/avg/total/group_concat/stat aggregates
files:
  - packages/quereus/src/func/builtins/aggregate.ts        # countStarFunc / countXFunc / sumFunc / avgFunc / totalFunc / groupConcatFuncRev / stat aggregates
  - packages/quereus/test/logic/51.7-maintained-table-attach-detach.sqllogic  # section 5 pinned shape
difficulty: easy
----

# Aggregate return-type fidelity

`createAggregateFunction` defaults `returnType` to `REAL nullable` when the
registration omits it. `count(*)` / `count(x)` omit it, so the planner
derives those as `REAL nullable` even though count always returns a non-null
integer. The maintained-table strict shape check now surfaces this directly.

## Plan

### Phase 1 — Fix `aggregate.ts` return types

In `packages/quereus/src/func/builtins/aggregate.ts`:

- Add import: `import { INTEGER_TYPE, REAL_TYPE, TEXT_TYPE } from '../../types/builtin-types.js';`

- **`countStarFunc`** (numArgs: 0): add `returnType: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }`
- **`countXFunc`** (numArgs: 1): same returnType
- **`sumFunc`**: add explicit `returnType: { typeClass: 'scalar', logicalType: REAL_TYPE, nullable: true, isReadOnly: true }` (sum of empty set is NULL — correct by SQL semantics; was the implicit default, now documented)
- **`avgFunc`**: same as sumFunc (REAL nullable — avg of empty set is NULL)
- **`totalFunc`**: add `returnType: { typeClass: 'scalar', logicalType: REAL_TYPE, nullable: false, isReadOnly: true }` (total() always returns 0.0, never NULL)
- **`groupConcatFuncRev`**: add `returnType: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }` (returns NULL for empty group)
- **`varPopFunc`, `varSampFunc`, `stdDevPopFunc`, `stdDevSampFunc`**: add explicit `returnType: { typeClass: 'scalar', logicalType: REAL_TYPE, nullable: true, isReadOnly: true }` (was implicit default, now explicit)

`min`/`max` already use `inferReturnType` — leave them alone.

`json_group_array`/`json_group_object` in `json.ts` and `stringConcatFunc` in `string.ts`
are user-visible but their type quirks are not blocking; leave for a follow-on ticket.

Window function MIN/MAX in `builtin-window-functions.ts` use `REAL_TYPE` incorrectly
(should follow arg type) but the window function schema lacks `inferReturnType` support;
that is out of scope — park in backlog.

### Phase 2 — Update the 51.7 test

In `packages/quereus/test/logic/51.7-maintained-table-attach-detach.sqllogic` section 5
(around line 209–226):

- Remove the parenthetical `(count(*) derives REAL nullable — the declared shape must say
  what the body derives, quirks included.)` from the comment — no longer true after this fix.
- Change `create table counts (w text not null collate binary primary key, n real null);`
  → `create table counts (w text not null collate binary primary key, n integer not null);`

### Phase 3 — Run tests

```
yarn test 2>&1 | tee /tmp/agg-type-test.log; tail -n 60 /tmp/agg-type-test.log
```

All existing tests should pass. The 51.7 aggregate-attach case is the regression net
for this change.

## Edge cases & interactions

- `count(DISTINCT x)` — the distinct aggregate path should pick up the same `count` schema
  (same numArgs: 1 registration). Verify it reports INTEGER not null.
- `count(*)` inside a window frame (`count(*) over (...)`) uses the window function
  registration in `builtin-window-functions.ts`, which already declares INTEGER not null
  correctly — no change needed.
- Shape-strict maintained tables: after the fix, any author who previously declared
  `n real null` for a count column will get a shape-mismatch error. That is intentional —
  they need to update their DDL to `n integer not null`. The 51.7 test is the only known
  instance.
- `total()` not null: if any test queries `total()` and expects a nullable result it will
  still get 0.0 (which is truthy) — no behavioral change, only type metadata.
- The `REAL_TYPE` default in `createAggregateFunction` remains as a safety net for
  third-party aggregate registrations that omit `returnType`; do not change it.

## TODO

- Phase 1: update aggregate.ts imports and add returnType to each listed function
- Phase 2: update 51.7 sqllogic test (section 5 comment + n column type)
- Phase 3: run `yarn test` and confirm all pass
- If a pre-existing failure surfaces outside this diff, write `.pre-existing-error.md`
