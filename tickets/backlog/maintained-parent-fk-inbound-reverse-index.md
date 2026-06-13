description: Optimization — precompute a "tables referencing M" reverse index so maintenance-driven parent-side FK enforcement skips the O(catalog) referencing-FK scan on every backing delete/update when nothing references the maintained table.
files:
  - packages/quereus/src/core/database-materialized-views.ts            # maintainRowTime / flushDeferredRebuilds enforcement hook
  - packages/quereus/src/runtime/foreign-key-actions.ts                 # the engine performs the per-call O(catalog) referencing-FK scan
prereq: maintained-table-parent-side-fk-orphan
----

# Cheap gate for maintained-parent referential enforcement

`maintained-table-parent-side-fk-orphan` wires parent-side referential enforcement into the
maintenance write path. For correctness it fires the engine
(`assertTransitiveRestrictsForParentMutation` + `executeForeignKeyActionsAndLens`) on every
delete/key-update of a maintained parent row when `pragma foreign_keys` is on. The engine
then scans **all** schemas/tables for FKs that reference the maintained table — an
`O(tables × FKs)` walk paid per backing change.

This matches the cost an ordinary `delete from M` already pays, so the first cut accepts it.
But maintenance can fan a single source write into **many** backing-row deltas, multiplying
the scan. A maintained table that **nothing** references still pays it on every maintenance
delete/update.

## Idea

Maintain a reverse index `referencedBy: Map<lowercased schema.table, Set<FK>>` (or a cheaper
boolean "is any FK pointing here") that the schema-change subscription keeps current as FKs
are added/dropped/retargeted (the `MaterializedViewManager` already subscribes to
`table_added` / `table_modified` / `table_removed`). The maintenance enforcement hook then
early-returns in O(1) when no FK references the maintained table — the parent-side analogue
of `derivedRowValidator`'s zero-overhead gate for the child side.

Consider whether the engine itself should consult such an index (benefiting ordinary writes
too) rather than a maintenance-local gate — the triage steer was "improve the general
architecture, not a special case." A shared catalog-level reverse FK index would let the DML
executor's per-row parent-side scan short-circuit as well.

## Caveats

- The index must track FK lifecycle precisely: declarative `apply schema`, `alter table add
  constraint`, FK retargets, and parent-table renames all move/retarget FKs. A stale index
  would silently drop enforcement — strictly worse than the unoptimized scan. Build it as a
  pure derived cache that can be rebuilt from the catalog, and prefer rebuild-on-event over
  incremental mutation unless the incremental path is provably exhaustive.
- Lens / logical FKs (`enforced-fk` obligations on lens slots) are discovered separately
  (`lens-fk-discovery.ts`); a general reverse index would need to cover them too, or the gate
  must conservatively fall through to the full scan whenever any lens slot is backed by the
  table.

Promote when maintenance throughput over FK-targeted maintained tables becomes a measured
concern.
