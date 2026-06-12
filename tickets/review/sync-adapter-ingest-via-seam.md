description: Review the sync store-adapter rewrite onto StoreTable.applyExternalRowChanges + Database.ingestExternalRowChanges (inbound sync now maintains secondary indexes, MVs, and Database.watch)
files:
  - packages/quereus-sync/src/sync/store-adapter.ts                  # the rewrite (options, grouping, apply, emission, seam call)
  - packages/quereus-sync/test/sync/store-adapter-seam.spec.ts       # NEW: 12 seam-integration tests
  - packages/quereus-sync/test/sync/store-adapter-pk-collation.spec.ts  # reworked to new options (scenarios unchanged)
  - packages/quereus-sync/test/sync/sync-protocol-e2e.spec.ts        # "correct KV store" test reworked onto real Database + StoreModule
  - packages/quoomb-web/src/worker/quereus.worker.ts                 # adapter construction simplified
  - packages/quereus-sync/README.md                                  # quick-start + API entry updated
  - README.md                                                        # root sync snippet updated
  - docs/materialized-views.md                                       # § DML replay vs. seam — live-consumer paragraph added
  - packages/quereus-store/src/common/store-table.ts                 # prereq surface consumed (unchanged here)
  - packages/quereus/src/core/database.ts                            # seam consumed (unchanged here)
----

# Review: sync store-adapter now applies via the store entry point and reports via the ingestion seam

## What was built

`createStoreAdapter` options are now `{ db, storeModule, events, applyForeignKeyActions? }`.
`getKVStore`, `getTableSchema`, and `collation` are **deleted** (breaking, per ticket — no
shims). The adapter no longer encodes keys or serializes rows itself; the
adapter-side `buildDataKey`/`resolvePkKeyCollations` duplication is gone.

Per `applyToStore` invocation:
1. Schema changes first via `db.exec` with `expectRemoteSchemaEvent` (unchanged).
2. Data changes grouped per table → per row. Each row group collapses to ONE
   `ExternalRowOp`: a delete in the group wins; otherwise column updates merge
   onto `table.readRowByPk(pk)` (or a PK+nulls partial row when absent —
   preserved UPSERT semantics). Table resolution via
   `storeModule.getTableForExternalWrite`; failure → per-change `result.errors`,
   other tables proceed.
3. `table.applyExternalRowChanges(ops)` writes committed storage + secondary
   indexes + stats and returns effective `BackingRowChange[]` (no-ops
   suppressed: absent delete, value-identical upsert).
4. Module events emitted from the effective changes with `remote: true`, now
   carrying `oldRow` (incl. on deletes — new) and `changedColumns` computed by
   `compareSqlValues` over the effective before/after images.
5. All tables' effective changes accumulate into ONE
   `db.ingestExternalRowChanges(batch, { applyForeignKeyActions })` call at the
   end (skipped when empty). Errored changes are excluded. A seam throw
   propagates out of `applyToStore`.

`change-applicator.ts`, `snapshot.ts`, `snapshot-stream.ts` needed **no code
changes** — the `ApplyToStoreCallback` signature is unchanged; each invocation
(delta batch / whole-snapshot apply / 100-change stream flush) is one seam
batch by construction.

## Validation performed

- `yarn build` green (includes quoomb-web's `tsc`, so the worker compiles
  against the new options; `yarn workspace @quereus/sync run typecheck` exit 0).
- `yarn workspace @quereus/sync run test`: 180 passing, 0 failing.
- New spec `store-adapter-seam.spec.ts` (all store-backed tables, in-memory provider):
  - covering-MV convergence on inbound insert / column-update / delete
  - update-for-absent-row → PK+nulls partial insert, visible in table AND MV
  - `Database.watch` row-granular hits post-apply
  - secondary-index store gains/loses entries on inbound apply; indexed query returns the row
  - no-op suppression: no module event, no watch dispatch, MV untouched, `dataChangesApplied` still counts the inputs
  - delete-wins grouping, both orders (update+delete / delete+update)
  - module-event shapes: `remote: true`, accurate `oldRow` chain, effective `changedColumns`, delete carries `oldRow`
  - FK opt-in default-off (children untouched) and on (cascade applies; cascaded child event has NO `remote` flag → recorded as local, propagates outward)
  - partial failure: unknown table errors per change, the resolvable table still applies and reaches the seam
  - seam-throw propagation through `SyncManagerImpl.applyChanges` (commit-time assertion): storage applied, CRDT metadata uncommitted, retry converges
  - no CRDT echo: `getChangesSince(originSiteId)` is empty after apply
- pk-collation spec: all 5 scenarios pass against table-owned keying.
- e2e "correct KV store" test reworked onto a real `Database` + `StoreModule`
  (per-table provider stores); also reads the row back through SQL.
- Other workspaces green: store 533 (see pre-existing note), isolation 126,
  sync-client 45, sync-coordinator 121, plugin-leveldb 17, plugin-indexeddb 62.
- **Pre-existing failures (not this ticket's):** `packages/quereus`
  `view-mv-ddl-persistence.spec.ts` (1 in full run, 14 in isolation —
  `generateMaintainedTableDDL` emits `CREATE TABLE … maintained as …`) and
  `packages/quereus-store` `mv-rehydrate-adopt.spec.ts` (2). Both in maintained-table
  subsystems untouched by this diff; flagged in `tickets/.pre-existing-error.md`.

## Behavior changes a reviewer should weigh

1. **Seam-throw retry does NOT re-drive the seam.** The implement ticket's
   design text said "re-application is idempotent … then the seam retries" —
   in reality a retry's value-identical upserts are suppressed, so the seam
   batch is EMPTY on retry: CRDT metadata converges, but the failed batch's
   derived effects (MV rows, watch dispatch) are permanently skipped until an
   MV refresh, and a commit-time assertion is NOT re-evaluated (so an
   assertion-violating inbound batch yields ONE error event, then converges
   silently with the violating row stored and the MV diverged for it — not an
   infinite poison loop). The new test pins this actual behavior and the
   adapter doc comment describes it. If the reviewer judges the design intent
   was a re-driven seam (re-deriving the batch from effective state on
   retry), that's a follow-up ticket, not a tweak.
2. **Blind deletes no longer emit events.** Previously an inbound delete of an
   absent row always emitted a module delete event; now fully suppressed
   (deliberate per ticket, pinned by test).
3. **`dataChangesApplied` granularity.** Now counted per table group
   (all-or-none on table failure); previously counted per row group as it
   went, so a mid-table failure could both count and error the same changes.
   Errors still cover ALL of a failed table's changes (pre-existing wart that
   sync metadata commits for errored changes is tracked in backlog
   `sync-apply-per-change-errors-ignored`).
4. **Per-table apply order** is grouping-map insertion order (first appearance
   in the inbound batch); the seam batch follows apply order. Cross-table
   ordering within one invocation is therefore first-seen order, not original
   interleaved change order — order is semantic for the seam's FK facet, so a
   stream relying on parents-before-children interleaving ACROSS tables in a
   single invocation with `applyForeignKeyActions: true` could differ from
   origin order. Default-off posture makes this benign for current consumers;
   worth a reviewer sanity check.
5. **Open-transaction / exec-context constraints are documented, not
   enforced** (adapter doc comment + READMEs): host-driven only, no explicit
   transaction open on `db` during `applyToStore`.

## Known gaps (honest)

- No test drives the **IndexedDB per-table-store** path end-to-end (covered
  indirectly: the reworked e2e test uses a per-table in-memory provider, and
  `plugin-indexeddb` tests pass; `StoreTable.ensureStore` does the routing).
- Snapshot bootstrap cost (full-rebuild MVs once per 100-change flush) is
  accepted and tracked separately in backlog
  `snapshot-bootstrap-defer-mv-maintenance`; no new test exercises
  `applySnapshotStream` against MVs.
- MV-over-MV convergence over inbound sync is asserted only transitively (the
  seam's own quereus-core tests cover the cascade); the sync-level spec stops
  at single MVs.
- `quoomb-web` worker change is compile-verified only (no browser e2e).
