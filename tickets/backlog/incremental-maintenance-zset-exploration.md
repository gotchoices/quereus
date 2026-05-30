----
description: Parked exploration — evaluate adopting a Z-set / DBSP-style delta-circuit internal representation for incremental maintenance (each relational operator carries a mechanical incremental lift; linear ops commute with delta, joins are bilinear, aggregates/recursion integrate), as a potential successor to the recompute-the-slice `MaintenancePlan` model. Deferred indefinitely by `incremental-maintenance-substrate-spike`; revisit only on a compelling constant-factor case.
prereq: incremental-maintenance-cost-gate
files: packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/core/database-transaction.ts, packages/quereus/src/runtime/delta-executor.ts, docs/incremental-maintenance.md
----

## Why this is parked, not active

`incremental-maintenance-substrate-spike` adjudicated the Z-set/DBSP thesis (Budiu/McSherry
et al. 2022, *DBSP: Automatic Incremental View Maintenance*) and **deferred it indefinitely**
in favour of the shared `MaintenancePlan` abstraction + backward cost gate built on the
recompute-the-slice model. This ticket preserves the analysis so the decision is revisitable,
not lost.

The spike's two findings that make Z-set a poor *near-term* fit here:

- **Change capture is not a Z-set.** `core/database-transaction.ts` (`mergeRecordInto`) is an
  op-keyed last-write-wins state machine (`{ op, oldProjection?, newProjection? }`), not a
  signed-weight multiset. Adopting Z-sets means **rewriting change capture itself** (weights,
  no UPDATE-as-primitive), not reading existing capture differently — a parallel new subsystem.
- **The synchronous policy caps the win.** Row-time maintenance runs inside the writing
  statement over a small per-statement change set; DBSP's asymptotic edge is largest for large
  batched deltas. For the small-delta in-transaction regime, residual-recompute on a
  key-filtered slice is usually already competitive.

## What would justify picking this up

- A measured, **consistent** in-transaction maintenance win (e.g. ≥2×) of a delta-circuit lift
  over the `'residual-recompute'` baseline at the small-delta operating point that dominates
  row-time, with the per-operator lift expressible without a bespoke integrator per aggregate
  (i.e. it generalizes), **and**
- a concrete need for the shapes a true-delta circuit wins on — notably recursive semi-naive
  evaluation and count-based set-op deltas (the deleted on-commit `complete/materialized-view-incremental-*`
  follow-ups), which the recompute-the-slice family does not maintain incrementally.

## Scope if picked up

A bounded, throwaway PoC first: a disposable signed-weight delta lift for `Filter`, `Project`,
and group-`count`/`sum` `Aggregate`, measured against the residual-recompute baseline on the
`bench/` harness across (table-size × changed-group-count) points, validated against the
maintenance-equivalence property oracle (`incremental-maintenance-plan-abstraction`). Adopt per
operator family only if it clears the bar above; otherwise re-shelve with the measurement
recorded. Any real adoption is a new representation + new capture + new executor — sequenced as
its own plan track, never a big-bang on a shared branch.

## Relationship to the shipped model

A Z-set adoption would slot in as an additional `MaintenanceStrategy` arm behind the same
backward cost gate (`incremental-maintenance-cost-gate`), chosen by cost when it wins — i.e. the
`MaintenancePlan` abstraction is forward-compatible with this exploration; nothing in the
recompute-the-slice path forecloses it.
