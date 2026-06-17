description: Review the FK-actions ordering-contract doc correction and order-independence regression tests.
prereq:
files:
  - packages/quereus/src/core/database.ts                     # ingestExternalRowChanges seam docstring (~1975)
  - packages/quereus/src/core/database-external-changes.ts    # FK-actions loop comment extended
  - packages/quereus/src/core/database-internal.ts            # applyForeignKeyActions doc — no change needed
  - packages/quereus-sync/src/sync/store-adapter.ts           # seamBatch construction comment (~183)
  - docs/sync.md                                              # § Apply-time validation (~434-460) — reconciled
  - docs/materialized-views.md                                # § External row-change ingestion — line 593 fixed
  - packages/quereus/test/external-row-change-ingestion.spec.ts  # two new order-independence tests added
difficulty: easy
----

## What was done

The ticket called for correcting documentation that overclaimed a "parents-before-children" ordering requirement on the FK-actions facet of `ingestExternalRowChanges`, and adding a regression test proving order doesn't matter for realistic shapes.

### Documentation fixes

- **`database.ts` seam docstring** (~line 1975): Removed the "order is semantic for FK actions … parents-before-children" claim. Replaced with accurate contract: same-row ordering matters (each change's `oldRow` must chain to the prior change's `newRow`); the FK-actions facet is order-independent for realistic shapes (re-reads post-write merged storage).

- **`docs/sync.md` § Apply-time validation** (~434-460): Resolved the self-contradiction ("order-independent by construction" + "lone order-sensitive consumer"). The passage now correctly states both facets (global assertions and FK actions) are order-independent for realistic batch shapes, explains why (the adapter writes all storage before the seam call so both FK helpers see fully-merged state), and documents the two exotic (E)/(F) limitations that no ordering fixes — along with the correct guidance (FK-actions-off default or global assertion).

- **`docs/materialized-views.md`** (line 593 of the `changes` array description): Removed the "origin order = parents-before-children" claim. Now states same-row ordering matters; FK-actions facet is order-independent (with a link to the (E)/(F) caveats).

### Code comment additions

- **`database-external-changes.ts`**: Extended the FK-actions loop comment to state cross-change order-independence, why it holds (post-write storage re-read), and the (E)/(F) caveats.

- **`store-adapter.ts`**: Added a four-line note at the `seamBatch` construction clarifying the array is table-grouped first-appearance order — not a dependency order and not required to be.

### New regression tests (2 tests added)

In `external-row-change-ingestion.spec.ts` → `foreign-key actions facet` describe:

1. **`multi-parent cascade: both orders succeed and empty the child table`** — Two independent parents each with one cascade child. Reports both parent deletes in order A then order B; asserts the child table is empty in both cases and no error is thrown.

2. **`direct child delete alongside parent delete: both orders succeed`** — A child row that was directly deleted from storage alongside its parent's delete. Reports the pair in both orders (child-first and parent-first); asserts both succeed (the cascade finds no child, which is a no-op).

### Tests

All 34 tests in the `external-row-change-ingestion.spec.ts` suite pass, including the 2 new ones. Full `yarn test` (214 tests across all packages) passes clean. `yarn lint` passes clean.

## Known gaps / reviewer focus

- The (E) exotic case (RESTRICT vs. relieving CASCADE on same child, two parent mutations) is **not** tested with a positive assertion — the ticket called for an optional `.skip` test to document the limitation. This was omitted; a reviewer may wish to add it or file a follow-up.
- The stale forward-reference in `docs/sync.md` that pointed to `tickets/backlog/sync-cross-table-apply-ordering.md` has been removed entirely (no replacement link was warranted since the guidance is now self-contained in the paragraph).
- `database-internal.ts` `IngestExternalChangesOptions.applyForeignKeyActions` doc had no ordering claim and needed no change.
