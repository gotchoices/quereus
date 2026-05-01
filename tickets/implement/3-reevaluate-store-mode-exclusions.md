description: Sweep MEMORY_ONLY_FILES for sqllogic exclusions whose underlying bug has since been fixed; remove ones that now pass under store mode
prereq: none
files:
  packages/quereus/test/logic.spec.ts
----

## Why this exists

`MEMORY_ONLY_FILES` in `packages/quereus/test/logic.spec.ts:39-60` was populated when the isolation-aware store harness was first wired up, with one entry per pre-existing isolation-layer or store-layer bug. Since then, several of the underlying bugs have been fixed in dedicated tickets, but the corresponding sqllogic files were never removed from the exclusion set:

- `10.1-ddl-lifecycle.sqllogic` — DROP+CREATE race (fixed by `complete/3-store-drop-create-race`).
- `102-schema-catalog-edge-cases.sqllogic` — same drop-create race.
- `40.1-pk-desc-direction.sqllogic` — PK DESC iteration order in store keys (fixed by `complete/3-store-pk-desc-iteration-order`).
- `41-alter-table.sqllogic` — RENAME TABLE (fixed by `complete/3-store-alter-table-rename-unsupported`); ADD COLUMN nullability (fixed by `review/3-store-add-column-ignores-default-nullability`).

Each of these fixes claimed in its completion notes that the originally-excluded scenario now passes, but the exclusion list was never pruned.

## Approach

For each candidate file:

1. Temporarily remove it from `MEMORY_ONLY_FILES`.
2. Run `yarn test:store -- --grep "<file>"` (or the equivalent targeted invocation).
3. If green, leave it removed and move on.
4. If failing, restore the entry and add an updated comment naming the *remaining* root cause (which may be a different bug than the one originally documented).

Candidates to test (in order):

- `10.1-ddl-lifecycle.sqllogic`
- `102-schema-catalog-edge-cases.sqllogic`
- `40.1-pk-desc-direction.sqllogic`
- `41-alter-table.sqllogic`

This ticket is purely a re-evaluation — it does not introduce production code changes unless a re-failure surfaces a *new* bug, in which case the new bug is its own ticket and this one keeps the file excluded with an updated comment.

## Validation

- `yarn test:store` is green after the sweep.
- `yarn test` (memory mode) — unchanged; these files still run under memory.
- For any file that re-failed and stays excluded, the inline comment in `MEMORY_ONLY_FILES` reflects the actual current root cause (not the historical one).

## TODO

- Test each of the four candidate files individually under store mode.
- Remove from `MEMORY_ONLY_FILES` any that pass.
- For files that fail with a *new* root cause, file a separate fix/implement ticket and leave the exclusion in place with an updated comment pointing at the new ticket.
- Run the full `yarn test:store` to confirm no regressions from the removals.
