description: First-class seam for externally-applied row changes (e.g. sync-inbound writes landing directly in a storage module) to drive Quereus's post-write pipeline — row-time MV maintenance (batch-amortized), FK actions, and change capture — so a downstream substrate like Lamina can delegate FK and derived-state maintenance to Quereus entirely.
files:
  - packages/quereus/src/runtime/emit/dml-executor.ts            # the post-write pipeline today: _record* → maintainRowTimeStructures → executeForeignKeyActionsAndLens
  - packages/quereus/src/core/database-internal.ts               # DatabaseInternal — the existing two-arg _maintainRowTimeCoveringStructures seam
  - packages/quereus/src/core/database.ts                        # 4-arg _maintainRowTimeCoveringStructures, _flushDeferredRebuilds, _hasRowTimeCoveringStructures
  - packages/quereus/src/core/database-materialized-views.ts     # maintainRowTime, BackingConnectionCache, deferred-rebuild set
  - docs/materialized-views.md                                   # § Synchronous, transactional, per-statement
  - docs/incremental-maintenance.md
----

# External row-change ingestion (post-write pipeline for non-DML writes)

## Background

Quereus's entire post-write pipeline lives in the DML executor
(`runtime/emit/dml-executor.ts`), fired per row immediately after each
`_recordInsert/_recordUpdate/_recordDelete`:

1. **change capture** (`_record*` → `Database.watch` / `ChangeScope` delta machinery),
2. **row-time MV maintenance** (`maintainRowTimeStructures` →
   `Database._maintainRowTimeCoveringStructures`), and
3. **FK actions** (`executeForeignKeyActionsAndLens`: CASCADE / SET NULL /
   SET DEFAULT propagation, RESTRICT pre-checks).

Any write that flows through Quereus DML — including writes to a table backed
by an external module like Lamina — gets all three for free. A write applied
**directly to module storage** (sync-inbound replication is the motivating
case) gets none of them.

The only externally-reachable seam today is
`DatabaseInternal._maintainRowTimeCoveringStructures(sourceBase, change)`
(`core/database-internal.ts`), designed for vtab-internal REPLACE evictions.
It is MV-maintenance-only and deliberately the cold two-arg form:

- no `BackingConnectionCache` → a per-row scan over the Database's active
  connections, measurable on a bulk inbound batch;
- no deferred-rebuild set → a `'full-rebuild'` MV reading the changed table
  rebuilds **inline per row**, O(rows × body) over a batch;
- no FK actions, no change capture — `Database.watch` subscribers and FK
  cascades never fire for the inbound change.

Downstream consequence (reported from the Lamina repo): Lamina must either
keep its own maintainer/FK machinery for sync-inbound changes, or drive
Quereus's seam row-by-row at cold-path cost — and even then FKs and watches
stay dark. The stated downstream goal is the opposite: **Lamina transitions to
having Quereus do its FK maintenance**, declaring FKs on the Quereus schema and
retiring its own propagation logic.

## Goal

An external writer that has applied row changes to its own storage can report
them to Quereus and have the post-write pipeline run — batch-efficiently,
inside the coordinated transaction, with each pipeline facet individually
selectable.

## Requirements / specification sketch

- **Batch ingestion surface** on `DatabaseInternal` (shape TBD in this plan):
  accepts an ordered batch of `{ sourceBase, change: BackingRowChange }` (or a
  per-source grouped form), owns a `BackingConnectionCache` and
  deferred-rebuild set for the batch, and flushes deferred full rebuilds once
  at the batch boundary — the external analogue of the DML generator's
  per-statement amortization (`docs/materialized-views.md` § Synchronous,
  transactional, per-statement).
- **Facet selection.** MV maintenance, FK actions, and change capture are
  independently enableable per call (or per registered source policy). This is
  load-bearing for sync: a replication stream typically already carries the
  *effects* of origin-side cascades, so re-running FK actions on inbound
  changes would double-apply them — yet a Lamina deployment that has retired
  its own FK maintenance for *local* writes still wants RESTRICT/CASCADE
  semantics when an inbound change orphans a local-only child. The plan must
  resolve this policy surface (likely: capture on by default, MV maintenance
  on by default, FK actions opt-in).
- **Transaction & visibility contract**, documented as part of the seam:
  - the call runs inside an active coordinated transaction; backing connections
    register lazily and commit/roll back in lockstep (existing behavior);
  - the residual maintenance arms re-read the source *through the vtab* against
    live state, so the inbound row must already be visible via the module's
    `query()` within that transaction when the seam is driven;
  - `sourceBase` key format (lowercased `schema.table`) pinned explicitly;
  - statement-boundary semantics for a batch: whether it rides a
    statement-atomicity savepoint, and where the deferred-rebuild flush sits
    relative to it (mirror `_flushDeferredRebuilds` placement in the DML
    generator).
- **Constraint stance.** Inbound rows are not re-validated against CHECK /
  NOT NULL / UNIQUE by this seam (the origin already enforced them); document
  that trust boundary explicitly. If a covering-UNIQUE structure exists over
  the source, decide whether the seam maintains it blindly (current
  `_maintainRowTimeCoveringStructures` behavior) or surfaces conflicts.
- **Evaluate the DML-replay alternative** and write the guidance down: applying
  inbound changes *as Quereus DML* gets every facet for free and may be the
  recommended integration for low-volume sync, with the raw seam reserved for
  bulk application where re-planning per row is prohibitive. The plan should
  produce a clear decision matrix for downstream integrators (Lamina docs will
  reference it).

## Use cases

- Lamina applies a sync-inbound `RowChangeEvent` batch to its `RowStore`, then
  reports the batch through the seam: covering MVs over the synced table stay
  consistent, `Database.watch` subscribers fire, and (per policy) FK RESTRICT
  protects local-only children — all without Lamina-side maintenance code.
- Lamina retires its own FK propagation for local writes by declaring FKs on
  the Quereus schema; local DML already runs `executeForeignKeyActionsAndLens`,
  and this seam closes the inbound gap so the delegation is total.
- A vtab performing internal storage-side mutations beyond REPLACE evictions
  (compaction-driven rewrites, TTL expiry) reports them and keeps derived state
  honest.
- **quereus-sync's own store-adapter is an in-repo consumer**: `applyRowChanges`
  (`packages/quereus-sync/src/sync/store-adapter.ts`) applies remote changes
  directly to the KV store today — the fix ticket
  `store-pk-collate-sync-adapter-rekey` explicitly flags (as out of its scope)
  that this path maintains no secondary indexes on applied changes; covering
  MVs, `Database.watch`, and FK actions are dark there for the same reason.
  This ticket is the tracking home for that deferred concern; the plan should
  evaluate migrating the adapter onto the new seam.

## Notes

- Independent of `mv-backing-module-pluggability` (where the *backing* lives);
  this ticket is about who *drives* maintenance and the rest of the pipeline.
  The two compose: a Lamina-hosted backing maintained from a Lamina-reported
  inbound batch.
- The existing two-arg `_maintainRowTimeCoveringStructures` stays as-is for the
  eviction path; the new surface should subsume rather than duplicate its
  internals (`maintainRowTime` already takes cache + deferred set — the gap is
  exposure and the FK/capture facets, not new maintenance machinery).
