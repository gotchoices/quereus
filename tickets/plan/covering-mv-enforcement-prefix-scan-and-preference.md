description: Row-time covering-MV UNIQUE enforcement (covering-structure-mv-rowtime-enforcement) currently does a FULL backing-table scan per conflict check, and `findIndexForConstraint` prefers that O(n) MV path over the O(log n) auto-index even for physical tables that have both. Add the backing-PK prefix scan and decide whether the MV should outrank the auto-index for physical schemas.
prereq:
files: packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus-store/src/common/store-table.ts, docs/materialized-views.md
----

## Problem

`MaterializedViewManager.lookupCoveringConflicts` (v1) does a **full layer scan** of the
covering MV's backing table for every UNIQUE conflict check
(`manager.scanLayer(startLayer, { indexName: 'primary' })`, matching UC values row by
row). And `MemoryTableManager.findIndexForConstraint` returns the `materialized-view`
covering variant **in preference to** the `memory-index` auto-index whenever a linked,
non-stale, non-diverged row-time covering MV exists.

Consequence: a *physical* table that happens to carry a row-time covering MV now resolves
every UNIQUE insert/update via an **O(n) backing scan** instead of the auto-index's
O(log n) probe — a bulk insert degrades to **O(n²)**. The auto-index remains maintained
but unconsulted. This was an intentional v1 choice (it makes the MV path live and testable
when the auto-index would otherwise always win — and is the sole structure in the future
lens/logical-schema world where the auto-index is retired), but it is a real regression
for physical schemas.

## Wanted

1. **Backing-PK prefix scan.** The covering MV's backing physical PK leads with the UC
   columns (covering-index shape), so a conflict check should be a prefix range scan /
   point lookup on the backing key, not a full scan. Recover the conflicting source PK
   from the backing row as today. This is the soundness-preserving optimization the
   implementer explicitly deferred. Apply to both the memory path
   (`lookupCoveringConflicts`) and the store path (which calls the same surface).

2. **Reconsider the preference for physical schemas.** Decide whether the auto-index
   should win until the prefix scan lands (physical tables keep O(log n)) while the MV
   path stays mandatory only in the logical-schema/lens world where no auto-index exists.
   Either way, document the decision.

## Notes

- The full-scan v1 and the preference tradeoff are documented in
  `docs/materialized-views.md` § "Enforcement through a row-time covering MV" → "The
  preference tradeoff". Update that section when this lands.
- The prefix scan must preserve the existing liveness contract: backing rows are a
  *candidate generator* validated against the live source row before acting (a backing
  entry can lag a row deleted/updated internally within the statement).
