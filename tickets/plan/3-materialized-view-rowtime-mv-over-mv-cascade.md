----
description: Cascaded maintenance flows through the spike MaintenancePlan execution path, uniform across arms; reuses the property test extended to chains; batching interaction preserved. Renamed (seq prefix 3).
prereq: materialized-view-rowtime-only-consolidation, incremental-maintenance-substrate-spike
files: packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/runtime/emit/dml-executor.ts, docs/materialized-views.md
----

> **Retargeted onto the shared maintenance substrate** (`incremental-maintenance-substrate-spike`).
> The dependency edge (producer backing base → consumer MV) and the synchronous,
> DAG-ordered drive stay as designed below, but the cascaded maintenance now flows through
> the spike's `MaintenancePlan` execution path: a maintenance write to backing `B` is fed
> to every `MaintenancePlan` whose source base is `B`, recursively, within the statement.
> This keeps cascade uniform across the `'inverse-projection'` / `'residual-recompute'`
> arms (a chain may mix shapes once `materialized-view-rowtime-general-bodies` lands) and
> reuses the spike's maintenance-equivalence property test, extended to multi-level chains,
> as the oracle. The per-statement batching interaction noted below (semantic edge B) is
> unchanged: cascaded backing writes apply through the same cached-connection mechanism
> that `materialized-view-rowtime-per-statement-batching` establishes, so intra-statement
> enforcement scans in a dependent MV observe prior rows of the same statement.

## Background

The row-time-only consolidation deleted the on-commit incremental cascade
machinery (topological ranks, the per-pass `pendingDelta` overlay,
`globallyChangedBacking`) that previously converged MV-over-MV chains at COMMIT.
Under row-time, maintenance is synchronous at the source row-write boundary —
there is no post-commit pass to cascade through. To keep tight scope, the
consolidation **rejects** an MV whose single source resolves to another MV's
backing table (`getMaterializedViewByBackingTable` returns an MV). This ticket
lifts that rejection.

## Use case

```sql
create materialized view mv1 as select id, x from t where x > 0;
create materialized view mv2 as select id, x from mv1;   -- rejected today
```

A write to `t` maintains `mv1`'s backing table via
`applyMaintenanceToLayer`. That privileged write does **not** re-enter the
DML-executor row-time hook, so `mv2` (whose source is `mv1`'s backing) is never
maintained. The user expects `mv2` to reflect `t` writes transparently, like any
materialized view.

## Approach

Drive dependents from the maintenance write itself: when
`maintainRowTime`/`applyRowTimeChange` writes a backing table `B`, feed those
changes to every `MaintenancePlan` whose `sourceBase === B` and recurse — DAG-ordered
(the MV-dependency graph is acyclic; an upstream MV must already exist at create),
within the same statement/transaction so the whole chain commits/rolls back atomically.
Build the dependency edges at registration (producer backing base → consumer MV) — a
minimal analogue of the deleted topo machinery, but synchronous and rooted on the
`MaintenancePlan` execution path the spike establishes.

Because each cascaded maintenance write goes through the same cached backing connection
that `materialized-view-rowtime-per-statement-batching` introduces, the
intra-statement visibility invariant is preserved automatically: a dependent MV's
enforcement scan (e.g. a covering-MV `unique` check in a chain) sees all prior rows
of the same statement that the cascade has already written.

Open points to resolve at implement time: capturing the per-row before/after backing
delta to feed the dependent's `MaintenancePlan` (the maintenance write knows its own
ops, so this is local — no source re-read); the correct flush order when a cascaded
write triggers another dependent's enforcement scan within the statement; and
depth/cycle guards at create time.

## Relationship to `materialized-view-rowtime-general-bodies`

A cascade chain may mix `'inverse-projection'` and `'residual-recompute'` arms once
general-bodies lands. This ticket does not implement those arms — it consumes
whichever arm the `MaintenancePlan` for each dependent specifies, routing the delta
uniformly through `applyMaintenanceToLayer`. The two tickets may ship in either order
against the spike; cascade requires only that the `MaintenancePlan` union and its
execution path exist.

## Acceptance

- An MV-over-MV chain (2+ levels) reflects a source insert/update/delete
  transparently and mid-transaction (reads-own-writes), and rolls back as a unit.
- The create-time MV-over-MV rejection from the consolidation is removed.
- Covering-MV UNIQUE enforcement still works when the covering MV sits in a chain.
- The spike's maintenance-equivalence property test (`read(MV_backing) == evaluate(body)`)
  extended to multi-level chains passes after every mutation and rollback.
- Intra-statement enforcement in a downstream MV (e.g. a unique covering structure at
  level 2) correctly observes all prior rows produced by the cascade within the same
  statement.
