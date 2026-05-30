----
description: Retargeted onto the shared MaintenancePlan substrate: implements residual-recompute + prefix-delete arms, cost-gated; consumes lateral-TVF backing PK from keysOf once join-keys lands. Renamed (seq prefix 3).
prereq: materialized-view-rowtime-only-consolidation, incremental-maintenance-substrate-spike, optimizer-keyed-cross-product-join-keys
files: packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/runtime/emit/dml-executor.ts, docs/materialized-views.md
----

> **Retargeted onto the shared maintenance substrate** (`incremental-maintenance-substrate-spike`).
> This ticket no longer designs residual maintenance from scratch. The spike establishes
> the `MaintenancePlan` strategy union and the backward maintenance **cost gate**; this
> ticket implements the `'residual-recompute'` arm (single-source aggregates and
> row-preserving inner/cross joins) and the `'prefix-delete'` arm (lateral-TVF fan-out)
> **on that abstraction**, choosing incremental-vs-rebuild via the cost gate rather than a
> hand-rolled ratio. The lateral-TVF backing PK comes from `keysOf` once
> `optimizer-keyed-cross-product-join-keys` lands (its product-key advertisement), so this
> ticket consumes that key instead of bespoke advertisement reasoning. The open "is
> residual re-execution affordable / where is the cost cliff" question below is now
> **answered by the spike's cost gate**, not re-opened here. The shared
> maintenance-equivalence property test from the spike is this ticket's regression oracle.

## Problem / future concern

`materialized-view-rowtime-only-consolidation` makes row-time the sole MV
maintenance model and restricts the eligible shape to the **covering-index shape**
(single-source, linear `Filter → Project → Sort`, deterministic projection
including the source PK), because that shape lets per-source-row maintenance be a
pure projection of the changed row — O(log n), no body re-execution. Everything
else is rejected at create.

The broader shapes that the (now-removed) `on-commit-incremental` policy used to
maintain at COMMIT are the natural next expansion of the row-time gate:

- **single-source aggregate** with `GROUP BY` over bare columns — per-statement
  maintenance must recompute the changed group(s), which means running the
  group's residual against current sources;
- **row-preserving inner/cross-join** bodies — maintenance recomputes the affected
  MV slice via a key-filtered residual (join fan-in);
- **lateral-TVF fan-out** — `delete-by-prefix` + recomputed fan-out per changed
  base row.

> **Note — the on-commit residual machinery is gone.** The consolidation deletes
> the per-binding residual / `computeDeleteKeyOrder` / `prefixDelete` /
> classification code that `on-commit-incremental` carried. This ticket therefore
> *rebuilds* synchronous, in-transaction residual maintenance for these shapes —
> it cannot lean on the old commit-time kernel. The hard parts are unchanged in
> spirit: deriving the affected backing slice per changed source row/group,
> running a key-filtered residual against the live (mid-transaction) source state,
> and the delete-then-upsert into the backing table — but now executed
> synchronously per statement, with rollback coupled to the source write, rather
> than asynchronously post-commit. The open question is whether a residual
> re-execution per statement is affordable for these shapes and where the
> cost cliff (degrade-to-full-rebuild) sits against a mid-statement boundary.

## Use case

A logical-schema (lens) `unique`/PK whose declared covering MV is *not* the simple
covering-index shape — e.g. a uniqueness claim provable only through an aggregate
or join body — needs row-time maintenance of that body to drive row-time conflict
resolution. Until then such a constraint cannot be materialized as a row-time
covering structure and must rely on detection-only commit-time enforcement (no
`insert or replace` / `or ignore`), as `docs/lens.md` documents under the
`lens.no-backing-index` advisory path.

## Out of scope (delivered by the prereq)

- The sole row-time model, the bare DDL (no `with refresh` clause), the
  mandatory create-time gate, the synchronous DML-boundary hook with per-statement
  batching, the privileged transactional maintenance write, the covering-index
  shape, and expression-projection support for that shape.

## Possible follow-up split

- **Cascading MV-over-MV under row-time** (deferred from the consolidation): an MV
  whose source is another MV's backing table. Requires the maintenance write to
  drive dependents synchronously (DAG-ordered) within the statement. File as its
  own ticket if the consolidation rejects MV-over-MV rather than supporting it.
