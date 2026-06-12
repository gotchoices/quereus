description: COMPLETE — sync store-adapter rewritten onto StoreTable.applyExternalRowChanges + Database.ingestExternalRowChanges. Inbound sync now maintains secondary indexes, materialized views, and Database.watch; breaking option change (getKVStore/getTableSchema/collation → storeModule/applyForeignKeyActions).
files:
  - packages/quereus-sync/src/sync/store-adapter.ts                  # the rewrite
  - packages/quereus-sync/test/sync/store-adapter-seam.spec.ts       # 12 seam-integration tests
  - packages/quereus-sync/test/sync/store-adapter-pk-collation.spec.ts
  - packages/quereus-sync/test/sync/sync-protocol-e2e.spec.ts
  - packages/quoomb-web/src/worker/quereus.worker.ts
  - packages/quereus-sync/README.md
  - README.md
  - docs/materialized-views.md
----

# Sync store-adapter applies via the store entry point and reports via the ingestion seam

## What was built

`createStoreAdapter` options are now `{ db, storeModule, events, applyForeignKeyActions? }`
(was `{ db, getKVStore, getTableSchema, events, collation? }` — breaking, no
shims). The adapter no longer encodes keys or serializes rows; each inbound
`applyToStore` invocation:

1. applies schema changes first (`db.exec`, pre-marked remote);
2. groups data changes per table → per row, collapsing each row group to ONE
   `ExternalRowOp` (delete-wins; column updates merge onto `readRowByPk` or a
   PK+nulls partial row);
3. writes via `StoreTable.applyExternalRowChanges(ops)` (table-owned keying,
   secondary-index + stats maintenance, no-op suppression), getting back the
   effective `BackingRowChange[]`;
4. emits module data events from the effective changes (`remote: true`, with
   `oldRow` and `compareSqlValues`-derived `changedColumns`);
5. reports all tables' effective changes as ONE
   `db.ingestExternalRowChanges(batch, { applyForeignKeyActions })` at the end.

Net effect: a covering MV, `Database.watch` subscription, or secondary index
over a synced table now converges on inbound apply — previously the adapter
wrote raw KV bytes and nothing downstream learned of the change.

## Review findings

Reviewed the implement diff (`756f6fca`) against the consumed prereq surface
(`StoreTable.applyExternalRowChanges` / `readRowByPk` /
`StoreModule.getTableForExternalWrite`, `Database.ingestExternalRowChanges` /
`ExternalRowChange`) with fresh eyes before reading the handoff.

**Verification run (all green):**
- `yarn workspace @quereus/sync run typecheck` → exit 0.
- `yarn workspace @quereus/sync run test` → **180 passing, 0 failing**
  (independently re-run; the logged `[Sync] Error handling…` lines are
  failing-KV mock assertions in `sync-manager.spec.ts`, expected).
- `yarn workspace @quereus/quoomb-web run typecheck` → exit 0 (worker compiles
  against the new options).
- Lint: `packages/quereus` (the only package with a meaningful lint gate) is
  untouched by this diff; `quoomb-web` has no eslint flat config (`yarn eslint`
  errors "couldn't find eslint.config.js" — pre-existing tooling state,
  unrelated). typecheck is the effective static gate for the changed packages
  and passes.

**Correctness / SPP / DRY — checked, no defects.**
- Per-row collapse guarantees each PK appears once per table in the seam batch,
  so the seam's same-row `oldRow`-chaining contract is satisfied trivially and
  `applyExternalRowChanges`' per-op `readEffectiveRowByKey` yields accurate
  before-images. Verified against the seam driver and the store method.
- No-op suppression aligns: store suppresses absent-delete + value-identical
  (`rowsValueIdentical`, byte-faithful) upserts; the adapter emits/reports
  nothing for suppressed changes. `changedColumns` uses `compareSqlValues`
  (default BINARY), so a collation-equal/byte-different update (store reports
  `update`) is still surfaced as a changed column. Pinned by the seam spec.
- Adapter-side key encoding / row (de)serialization duplication is fully
  deleted; keying is now table-owned (the prior NOCASE-hardcoded worker path is
  gone — strictly more correct for non-NOCASE / per-column-collation PKs, pinned
  by the reworked pk-collation spec).
- Type safety: no `any`; the e2e test's old `null as unknown as Database` hack
  was removed in favor of a real `Database` + `StoreModule`.
- Worker cleanup: dead `getKVStore` removed; the retained local `getTableSchema`
  is still consumed by the sync-module column mapping (not dead).

**Tests — strong starting point, accepted as-is.** The 12-test seam spec covers
happy path (insert/update/delete MV convergence), edge cases (update-for-absent
→ PK+nulls partial; no-op suppression; delete-wins both orders), error paths
(unknown-table partial failure; seam-throw propagation through
`SyncManagerImpl.applyChanges` with assertion + retry), regressions
(pk-collation; no-CRDT-echo), and interactions (secondary index, watch,
FK opt-in on/off). Reworked e2e drives a real engine and reads rows back
through SQL.

**Docs — verified current.** Adapter doc comment, root README, `quereus-sync`
README (API entry + quick-start), and `docs/materialized-views.md` (new
live-consumer paragraph) all read against the new option surface and behavior;
accurate.

**Findings dispositioned:**
- *Minor (no change — informational):* `changedColumns` now reflects a VALUE
  diff rather than the touched-column set, so a numerically-equal/byte-different
  update (e.g. int `1` → float `1.0`, which the store still reports as `update`)
  yields an empty `changedColumns`. Documented as intentional in the handoff;
  acceptable. No edge test pins the empty case — left as-is.
- *Minor (no change):* an upsert does two point reads (adapter `readRowByPk` +
  store `readEffectiveRowByKey`). Inherent to the column-merge / full-row-upsert
  layer boundary; not worth collapsing.
- *Minor (no change):* the `applyOptions` callback parameter is now effectively
  unused (threaded only to `applySchemaChange`, which ignores it). Mandated by
  the `ApplyToStoreCallback` signature; pre-existing.
- *Major (filed, not inline-fixable):* on a seam throw (inbound batch violates a
  commit-time global assertion), the violating storage rows stay applied but the
  derived effects (MV deltas, watch dispatch) are unwound; the retry's
  value-identical upserts suppress to an EMPTY seam batch, so those effects are
  never re-driven — incremental MVs diverge from the base table for that row
  until a manual refresh. Documented + tested as current behavior and flagged by
  the implementer for reviewer judgment; closing it is a design change. Filed
  `tickets/backlog/sync-seam-throw-retry-mv-divergence.md`. The adjacent
  non-atomicity of `applyExternalRowChanges` (mid-table throw → earlier ops
  committed-but-unreported) folds into the existing
  `sync-apply-per-change-errors-ignored` backlog ticket; no new ticket.

**Pre-existing failures (not this diff):** `packages/quereus`
`view-mv-ddl-persistence.spec.ts` and `packages/quereus-store`
`mv-rehydrate-adopt.spec.ts` — maintained-table subsystems this diff never
touches (it only changes `quereus-sync`, `quoomb-web`, docs). Already captured
in `tickets/.pre-existing-error.md` and triaged by the runner (commit
`181f5685`). Not re-investigated here per pre-existing-failure policy.

**Honest residual gaps (carried from the handoff, accepted):** no end-to-end
IndexedDB per-table-store test (covered indirectly via the in-memory
per-table provider + passing `plugin-indexeddb` suite); snapshot-bootstrap MV
cost tracked in backlog `snapshot-bootstrap-defer-mv-maintenance`; MV-over-MV
inbound convergence asserted only transitively via the engine's own seam tests;
`quoomb-web` worker change is compile-verified only.

## Disposition

No inline code changes were required — the implementation is correct, typed,
documented, and well-tested. One major design follow-up filed to backlog; minor
findings recorded as informational. Spawned ticket:
`sync-seam-throw-retry-mv-divergence`.
