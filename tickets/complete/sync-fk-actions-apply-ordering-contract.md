description: Corrected documentation that wrongly claimed external row-change ingestion required parents-before-children ordering for foreign-key actions, and added regression tests proving order does not matter.
prereq:
files:
  - packages/quereus/src/core/database.ts                     # ingestExternalRowChanges seam docstring (~1975) — cross-ref fixed
  - packages/quereus/src/core/database-external-changes.ts    # FK-actions loop comment extended
  - packages/quereus-sync/src/sync/store-adapter.ts           # seamBatch construction comment (~183)
  - docs/sync.md                                              # § Transactional Integrity During Sync — (E)/(F) caveats live here
  - docs/materialized-views.md                                # § External row-change ingestion — line 593 cross-ref fixed
  - packages/quereus/test/external-row-change-ingestion.spec.ts  # two order-independence tests
difficulty: easy
----

## Summary

The implement stage corrected documentation that overclaimed a "parents-before-children" ordering requirement on the FK-actions facet of `ingestExternalRowChanges`, reconciled a self-contradiction in `docs/sync.md`, added clarifying code comments, and added two order-independence regression tests. The core technical claim — that the FK-actions facet is order-independent for realistic batch shapes because the store adapter writes all storage before the single seam call and both FK helpers re-read post-write merged state — is **correct and verified against the implementation** (see Review findings).

The seam contract now reads accurately: same-row ordering is the only ordering that matters (each change's `oldRow` must chain to the prior change's `newRow`); the FK-actions facet is order-independent except for two exotic multi-parent topologies (E)/(F) that no seam-batch ordering can fix, handled by the default `applyForeignKeyActions: off` or by a global assertion.

## Review findings

### What was checked

- **Implement diff read with fresh eyes** (`git show 14e8a945`) before the handoff summary.
- **Correctness of the central order-independence claim** — traced both FK helpers in `packages/quereus/src/runtime/foreign-key-actions.ts`:
  - `assertNoRestrictedChildrenForParentMutation` and `assertTransitiveRestrictsForParentMutation` enumerate children via `db.prepare(sql)` → `_iterateRowsRaw()` against live storage;
  - `executeSingleFKAction` issues cascade DML via `db._execWithinTransaction` against live storage.
  Since `ingestExternalRowChangeBatch` runs these *after* the caller (store adapter) has written every table's rows to storage, both helpers observe the fully-merged post-write state regardless of seam-batch order. The claim holds. The (E)/(F) exotic limitations are correctly characterized as the residue.
- **Test quality** — read the helpers (`directWrite`, `chg`, `readAll`) and the surrounding `foreign-key actions facet` describe block. The two new tests mirror the established pattern (direct-write storage, then seam call with the facet on) and assert both orderings. Test 1 (independent multi-parent) is a weak order-sensitivity probe by construction (the cascades are independent) but still validates the re-read path; test 2 (pre-deleted child + parent) is the more meaningful one — it proves a cascade finding no child is a no-op, not an error, in both orders.
- **Doc cross-references** — followed every link the change introduced or touched.
- **Dangling references** — confirmed no remaining references to the removed `tickets/backlog/sync-cross-table-apply-ordering.md` in `docs/` or `packages/`.
- **Remnant sweep** — grepped for `parents-before-children` / `order is semantic` / `order-sensitive` / `lone order` across source. No stale wording remains in source (the only hits are an unrelated `view-updateability.md` feature, unrelated planner/test comments, and stale `dist/` build output).
- **Lint** (`yarn lint`, eslint + `tsc -p tsconfig.test.json`): clean.
- **Tests**: targeted suite (34/34 incl. the 2 new) and full `yarn test` (all workspaces) green.

### What was found

**Minor (fixed inline):** Two broken/misleading documentation cross-references introduced by the implement diff. Both pointed readers to the (E)/(F) exotic-topology caveats at a location where they do not exist — the caveats actually live in `docs/sync.md` under `### Transactional Integrity During Sync`:

1. `packages/quereus/src/core/database.ts` (~1979) — directed readers to "`docs/materialized-views.md` § External row-change ingestion for the (E)/(F) ... caveats", but that section contains no (E)/(F) text. **Fixed** to point to `docs/sync.md` § Transactional Integrity During Sync.
2. `docs/materialized-views.md` (line 593) — linked `[§ applyForeignKeyActions](#applyforeignkeyactions)` for the (E)/(F) caveats, but there is no `applyForeignKeyActions` *heading* (it is a bullet under `### Facets`), so the anchor was broken, and the caveats are not in that file. **Fixed** to a cross-file link `[sync.md § Transactional Integrity During Sync](sync.md#transactional-integrity-during-sync)`.

### What was deliberately not done

- **The optional (E) `.skip` documentation test was not added.** The (E)/(F) limitations are now documented in prose in three places (`docs/sync.md`, the `database-external-changes.ts` FK-actions loop comment, and the `docs/materialized-views.md` cross-reference). A `.skip` test asserting nothing adds no coverage and would duplicate prose; the ticket marked it optional. No follow-up filed — the limitation is well-described and is the intended behavior, not a bug.

### Empty categories

- **No major findings** — nothing warranting a new fix/plan/backlog ticket. The implementation's central claim is sound, the facet is genuinely order-independent for the documented shapes, and the tests pass.
- **No new bugs, error-path gaps, type-safety, or resource-cleanup issues** found in the touched code. The change is documentation + comments + tests only; the test FK setup correctly uses `not null references ... on delete cascade` and exercises both orderings with full teardown via the suite's `afterEach` `db.close()`.
- **Stale `dist/` build output** (`packages/quereus/dist/src/core/database.d.ts`) still carries the old "parents-before-children" wording — left as-is; it is generated output regenerated by `yarn build`, not hand-maintained source.
