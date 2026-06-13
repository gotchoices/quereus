description: Precompute a "tables referencing M" reverse-index so maintenance-driven parent-side FK enforcement on a maintained table can skip the O(catalog) referencing-FK scan when nothing references M.
files:
  - packages/quereus/src/core/database-materialized-views.ts   # enforceParentSideReferentialActions — the per-change caller
  - packages/quereus/src/runtime/foreign-key-actions.ts         # assertTransitiveRestrictsForParentMutation / executeForeignKeyActionsAndLens — the engine that scans every table's FKs
difficulty: medium
----

# Reverse-index for inbound FKs on maintained tables (parent-side enforcement fast-path)

## Context

`maintained-table-parent-side-fk-orphan` landed parent-side referential enforcement for
steady-state maintenance: when maintenance deletes / key-updates a maintained table `M`
that is the parent (FK target) of an FK declared on an ordinary table `C`, the shared
referential-action engine fires (RESTRICT walk + CASCADE / SET NULL / SET DEFAULT).

Per delete/update backing change, `enforceParentSideReferentialActions` calls the engine,
whose RESTRICT walk and action executor each scan **every table's foreign keys** in the
catalog looking for one whose `referencedTable === M.name`. This `O(catalog)` scan is the
**same** cost an ordinary `delete from M` pays — so it is parity, not a regression — but on
a bulk maintenance write over a table that **nothing** references, the scan is pure waste,
repeated per affected row (bounded-delta arms) or per rebuild-diff row (full-rebuild arm).

## What's wanted

A precomputed reverse-index — "set of tables (and their FKs) that reference table `X`" —
kept current by the schema-change subscription (the same `getChangeNotifier()` stream the
manager already consumes for staleness / validator rebuilds). With it, the parent-side
enforcement hook can early-return in O(1) when no FK references `M`, and the engine itself
could consult it instead of the full catalog scan.

This is a **performance** optimization only — no behavior change. The functional path is
already correct and tested (`test/runtime/maintained-parent-fk.spec.ts`).

## Considerations / open questions

- The index would benefit the **ordinary** DML parent-side path too (`delete from M` /
  `update M`), not just maintenance — scope the reverse-index at the engine
  (`foreign-key-actions.ts`) level rather than maintenance-only, so both callers share it.
- Cross-schema FKs (`fk.referencedSchema`) must key the index by qualified name.
- Lens / logical FKs participate in the lens-routed path; a reverse-index must either cover
  them or the fast-path must only skip the **physical** scan and still run the logical step
  when `lensRouted` (maintenance writes are `lensRouted = false`, so the maintenance caller
  is unaffected, but a shared engine-level index must not regress the lens path).
- Invalidation: `table_added` / `table_removed` / `table_modified` (FK add/drop via ALTER,
  rename propagation that rewrites `referencedTable`) must all keep the index current — the
  same events the manager's subscription already handles.

## Use case

A maintained aggregate / projection `M` with high write volume and **no** inbound FKs (the
common case) should pay zero parent-side-enforcement overhead per maintained row beyond the
`foreign_keys`-pragma check, rather than an `O(catalog)` scan per delete/key-update change.
