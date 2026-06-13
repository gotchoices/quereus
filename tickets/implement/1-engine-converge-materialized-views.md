description: Add an engine convergence primitive that refreshes every materialized view in source-dependency order — the deferred-maintenance catch-up point after a wholesale external load
prereq:
files:
  - packages/quereus/src/core/database.ts                       # new public refreshAllMaterializedViews()
  - packages/quereus/src/core/database-materialized-views.ts    # enumeration + source-base topo order (planSourceBases, rowTimeBySource)
  - packages/quereus/src/runtime/emit/materialized-view.ts      # emitRefreshMaterializedView — extract per-MV refresh core into a shared helper
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts # shared full-rebuild path the two refresh arms funnel through
  - packages/quereus/src/schema/manager.ts                      # getAllMaintainedTables(), getMaintainedTable()
  - packages/quereus/src/schema/derivation.ts                   # isMaintainedTable, MaintainedTableSchema
  - docs/materialized-views.md                                  # document the convergence method
difficulty: medium
----

# Engine: converge all materialized views in source-dependency order

## Context

`refresh materialized view <name>` (`emitRefreshMaterializedView` in
`runtime/emit/materialized-view.ts`) re-runs ONE MV's body and full-rebuilds
its backing — the always-correct convergence point that works for both
bounded-delta and full-rebuild MVs. There is currently no way to converge
**every** MV at once.

The downstream sync bootstrap ticket (`sync-bootstrap-defer-mv-maintenance`)
needs exactly that: after applying a wholesale external load with row-time MV
maintenance deferred, it must bring every MV current in a single pass. The
ordering knowledge (which MV reads which source, including MV-over-MV) lives in
the engine (`MaterializedViewManager`), so the convergence primitive belongs
here — not reconstructed from schema internals by the sync layer.

## Design

Add a public method on `Database`:

```ts
/**
 * Refresh every maintained table (materialized view) in source-dependency
 * order, bringing each backing current with its sources. The convergence
 * point after a wholesale external load (e.g. a sync snapshot bootstrap) that
 * deferred row-time maintenance. Each MV is refreshed through the same
 * full-rebuild path as `refresh materialized view` (stale revalidation,
 * shape re-derivation/reshape, row-time re-registration, `stale` clear).
 * Returns the refreshed MV identifiers (for coarse watch notification).
 */
public async refreshAllMaterializedViews(): Promise<Array<{ schemaName: string; name: string }>>
```

### Ordering

MV-over-MV is supported (an MV body may read another MV's backing; in the
unified model an MV's backing IS a table under the MV's own name, so a
dependent MV's source bases contain the base MV's qualified name). Refresh is
**commit-first** — `replaceContents` swaps committed state and the swap is not
undone by an enclosing `rollback` (see the helper docs at
`materialized-view-helpers.ts` ~line 1281). Therefore sequential per-MV
refresh in topological order is correct: refreshing a base MV commits its
backing before a dependent MV's body re-reads it.

Build the order in `MaterializedViewManager`:
- Enumerate via `schemaManager.getAllMaintainedTables()`.
- For each MV, its prerequisites are its source bases (lowercased
  `schema.table`) intersected with the set of MV keys. Source bases for a
  registered MV come from its live plan (`planSourceBases` /
  `rowTimeBySource`); a **stale** MV has no row-time plan, so its source bases
  must be re-derived from the body (the same analysis `buildFullRebuildPlan`
  performs). Expose a small accessor (e.g.
  `MaterializedViewManager.sourceBasesFor(mv)`) that returns the live plan's
  bases or, for a stale MV, derives them from `derivation.selectAst`.
- Topologically sort (Kahn / DFS). On a cycle (should be impossible — the
  create-time gate rejects recursive MVs) throw `StatusCode.INTERNAL` rather
  than silently dropping an MV.

### Reuse — do NOT duplicate refresh logic

Extract the per-MV refresh core from `emitRefreshMaterializedView`'s `run`
(everything after the `getMaintainedTable` lookup: stale revalidation → shape
re-derivation → `reshapeBacking`/`rebuildBacking` → `registerMaterializedView`
→ clear `stale` → `materialized_view_refreshed` notify) into a shared exported
helper, e.g. `refreshMaintainedTable(db: Database, mv: MaintainedTableSchema)`.
Both `emitRefreshMaterializedView` and `refreshAllMaterializedViews` call it.
No second copy of the rebuild path.

### Transaction

Do NOT wrap the whole sweep in one explicit transaction — refresh is
commit-first per MV and an enclosing transaction would not make it atomic
anyway. Each MV refresh ensures/commits its own (implicit) transaction exactly
as the single-MV path does today. Note the non-atomicity in the doc: a failure
partway leaves earlier MVs converged; the caller (snapshot bootstrap) retries
the whole load idempotently.

## Edge cases & interactions

- **No MVs:** returns `[]`, no transaction, no throw.
- **Single MV, no MV-over-MV:** trivial order; one refresh.
- **MV-over-MV chain (a→b→c):** refreshed base-first; the dependent reflects
  the freshly committed base. Pin with a test asserting `c` reflects all of
  `a`'s rows after a single `refreshAllMaterializedViews()`.
- **Stale MV** (a structural source change released its row-time plan): the
  shared helper already revalidates the body and re-registers row-time;
  source-base derivation for ordering must not assume a live plan exists.
- **MV whose source had out-of-band (direct-storage) writes with no
  maintenance** (the bootstrap scenario): full rebuild re-reads the complete
  source through the vtab — converges regardless of how the rows arrived.
- **Bounded-delta MV:** refresh full-rebuilds it (the bounded-delta arm is
  bypassed), so deferral correctness does not depend on delta replay.
- **Cycle / self-reference:** throw INTERNAL (create-time gate should prevent
  this; the throw is a backstop, not a silent skip).
- **Concurrency:** each per-MV refresh acquires the exec mutex via the normal
  statement path; the method must not be called from within statement
  execution or a vtab callback (same constraint as `refresh` itself).
- **Empty-body MV:** full rebuild yields zero rows (`replace-all []`), emptying
  the backing — correct.

## TODO

- Extract `refreshMaintainedTable(db, mv)` shared helper from
  `emitRefreshMaterializedView`; rewire the emit path to call it.
- Add `MaterializedViewManager.sourceBasesFor(mv)` (live plan bases, or body-
  derived bases for a stale MV) and a topological-order builder over
  `getAllMaintainedTables()`.
- Add `Database.refreshAllMaterializedViews()` driving the ordered sweep,
  returning the refreshed `{ schemaName, name }` list.
- Tests (`packages/quereus/test/`, new spec, e.g. `mv-converge-all.spec.ts`):
  - No MVs → `[]`.
  - Full-rebuild MV (e.g. `select distinct …`) over a source filled by direct
    vtab writes (no DML maintenance) → after `refreshAllMaterializedViews()`
    the MV reflects every row; returned list names it.
  - Bounded-delta MV (e.g. keyed projection) over the same out-of-band source
    → converges identically.
  - MV-over-MV chain → dependent reflects base after one sweep (asserts
    base-first ordering; an arbitrary order would leave the dependent stale).
  - Stale MV (force-mark stale, then a body-relevant source change) →
    converges, clears `stale`, re-registers row-time (a subsequent in-band DML
    write maintains it).
- Document `refreshAllMaterializedViews` in `docs/materialized-views.md`
  (placement, ordering, commit-first non-atomicity, the deferred-load use
  case) alongside the External row-change ingestion section.
- Run `yarn workspace @quereus/quereus test` and `yarn lint`.
