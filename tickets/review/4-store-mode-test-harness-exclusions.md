description: Confirm memory-only sqllogic exclusions are in place; close out as duplicate of completed work
prereq: none
files:
  packages/quereus/test/logic.spec.ts
  tickets/complete/store-mode-test-harness-exclusions.md
----

This ticket re-surfaced after the original (`complete/store-mode-test-harness-exclusions.md`, commit `aaccde55`) had already landed. No code change was needed during implement — the three target entries were already present in `MEMORY_ONLY_FILES` with their documented rationale.

### State at review entry

`packages/quereus/test/logic.spec.ts:54,58,59` contains:

- `83-merge-join.sqllogic` — `Asserts planner picks MergeJoin for PK equi-join; store's cost model can validly prefer HashJoin`
- `103-database-options-edge-cases.sqllogic` — `Asserts default_vtab_module='memory'; store-mode harness sets it to 'store'`
- `105-vtab-memory-mutation-kills.sqllogic` — `White-box mutation tests targeting src/vtab/memory/ internals`

### Verification performed during implement

`node test-runner.mjs --store --grep "83-merge-join|103-database-options-edge-cases|105-vtab-memory-mutation-kills"` → 0 passing, 3 pending, 0 failing.

### Review focus

- Spot-check that `MEMORY_ONLY_FILES` still contains the three entries and the inline rationale matches what the harness needs.
- Confirm no additional churn was introduced (no production code touched).
- Forward to `complete/` as a duplicate of the original; no new complete summary needed beyond a pointer to `complete/store-mode-test-harness-exclusions.md`.
