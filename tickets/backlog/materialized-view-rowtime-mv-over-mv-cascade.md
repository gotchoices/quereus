description: Support a row-time materialized view whose source is **another MV's backing table** (MV-over-MV). Today such a body is rejected at create (by `materialized-view-rowtime-only-consolidation`) because a backing-table write goes through the privileged `applyMaintenanceToLayer` path, not the DML-executor hook that fires row-time maintenance — so a dependent MV would never be maintained and would silently serve stale rows. This ticket makes the maintenance write drive its dependents synchronously, DAG-ordered, within the same statement.
prereq: materialized-view-rowtime-only-consolidation
files: packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/runtime/emit/dml-executor.ts, docs/materialized-views.md
----

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

## Approach (to design in plan/implement)

Drive dependents from the maintenance write itself: when
`maintainRowTime`/`applyRowTimeChange` writes a backing table `B`, treat that write
as a source change for any row-time plan whose `sourceBase === B` and recurse —
DAG-ordered (the MV-dependency graph is acyclic; an upstream MV must already exist
at create), within the same statement/transaction so the whole chain commits/rolls
back atomically. Build the dependency edges at registration (producer backing base
→ consumer MV) — a much smaller analogue of the deleted topo machinery, but
synchronous rather than post-commit.

Open points: capturing the per-row before/after backing delta to feed the
dependent's projection (the maintenance write knows its own ops, so this is local —
no source re-read); interaction with per-statement batching
(`materialized-view-rowtime-per-statement-batching`) so a cascaded write is visible
to a dependent's enforcement scan within the statement; and depth/cycle guards.

## Acceptance

- An MV-over-MV chain (2+ levels) reflects a source insert/update/delete
  transparently and mid-transaction (reads-own-writes), and rolls back as a unit.
- The create-time MV-over-MV rejection from the consolidation is removed.
- Covering-MV UNIQUE enforcement still works when the covering MV sits in a chain.
