----
description: Review: isolation FK cascade through overlay — verify 29-constraint-edge-cases and 43-transition-constraints pass in store mode
prereq: none
files:
  packages/quereus/test/logic.spec.ts
  packages/quereus/test/logic/29-constraint-edge-cases.sqllogic
  packages/quereus/test/logic/43-transition-constraints.sqllogic
  packages/quereus-isolation/src/isolated-table.ts
  packages/quereus/src/runtime/foreign-key-actions.ts
----

## What was done

The ticket investigated whether CASCADE DELETE through the isolation overlay and transition-constraint row counts were broken in store mode.

**Finding:** Both issues had already been resolved by previous tickets in the implementation queue. The cascade DELETE path correctly routes through `IsolatedTable.update({operation:'delete'})` which writes tombstones to the per-connection overlay. Transition constraints (`committed.*` schema reads) also work correctly through the overlay/underlying merge.

**Change:** Removed `29-constraint-edge-cases.sqllogic` and `43-transition-constraints.sqllogic` from the `MEMORY_ONLY_FILES` exclusion set in `packages/quereus/test/logic.spec.ts`.

## Test results

- `yarn test` (memory mode): 121 passing — no regressions
- `yarn test:store` (store mode): 2429 passing / 16 pending — was 2427/18 before; net +2 passing, confirming both files now pass

## Review checklist

- [ ] Confirm no logic or behavior changes — only the exclusion list was modified
- [ ] Verify `29-constraint-edge-cases.sqllogic` tests all pass: multi-row CASCADE DELETE, 3-level cascade, SET NULL cascade, multi-assertion, deferred CHECK + assertion, multi-child-table, savepoint + deferred, multi-statement fix, FK→CHECK violation, cross-table assertion
- [ ] Verify `43-transition-constraints.sqllogic` tests all pass: `committed.*` CHECK, new rows, assertion cardinality, multi-committed assertion, no-deletes assertion, CHECK+assertion together
- [ ] No other files changed besides `logic.spec.ts`
