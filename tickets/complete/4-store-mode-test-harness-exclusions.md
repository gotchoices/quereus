description: Mark memory-specific sqllogic files as excluded from store mode
prereq: none
files:
  packages/quereus/test/logic.spec.ts
----

Added three files to `MEMORY_ONLY_FILES` in `packages/quereus/test/logic.spec.ts:44-46`, each with an inline comment explaining why it is memory-only:

- `83-merge-join.sqllogic` — asserts planner picks MergeJoin for PK equi-join; store's cost model can validly prefer HashJoin
- `103-database-options-edge-cases.sqllogic` — asserts `default_vtab_module='memory'`, which the store harness overrides to `store` at line 508
- `105-vtab-memory-mutation-kills.sqllogic` — white-box mutation tests targeting `src/vtab/memory/` internals

### Review outcome

- Implementation is minimal and well-scoped — only the exclusion set changed, no production code touched.
- Inline comments clearly document the memory-only rationale for each entry (keeps the set self-explanatory as it grows).
- No DRY/SPP/modularity concerns; this is a data-table addition.
- No docs required — the `MEMORY_ONLY_FILES` mechanism is internal to the test harness.

### Verification

- `yarn workspace @quereus/quereus test --grep "83-merge-join|103-database-options-edge-cases|105-vtab-memory-mutation-kills"` — 3 passing in memory mode.
- `QUEREUS_TEST_STORE=true yarn workspace @quereus/quereus test --grep "..."` — 3 pending (properly skipped) in store mode.

### Usage

- `yarn test` — memory mode still executes all three files.
- `QUEREUS_TEST_STORE=true yarn test` (or `yarn test:store`) — the three files skip cleanly.
- To add a future memory-only file: append to `MEMORY_ONLY_FILES` with a one-line comment stating why it can't run under store.
