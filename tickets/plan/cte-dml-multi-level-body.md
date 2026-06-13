description: Let a CTE-name DML target whose body reads ANOTHER CTE (`with a as (…), t as (select * from a) insert into t …`) write through transparently by inlining the multi-level CTE chain down to its base table(s), instead of rejecting with `no-base-lineage`. Only pursue if a consumer needs it — pinned as a v1 boundary today.
prereq:
files:
  - packages/quereus/src/planner/mutation/single-source.ts        # analyzeView lineage walk reaches a CTEReference node → no-base-lineage
  - packages/quereus/src/planner/building/dml-target.ts            # resolveCteTarget builds the ephemeral adapter over cte.query
  - packages/quereus/src/planner/building/with.ts
  - docs/view-updateability.md                                    # § ... → v1 boundary (multi-level CTE body)
difficulty: hard
----

# CTE-name DML target: transparent multi-level (CTE-over-CTE) body

## Background

The cte-name-dml-write-target work routes a leading-WITH CTE target's body through the
view-mutation substrate. The substrate's updateability walk requires a single-source (or
two-table join) body whose lineage terminates in a **base table**.

## The deferred behavior

A CTE body that reads *another* CTE —

```sql
with a as (select id, color from ml), t as (select * from a) update t set color = 'z' where id = 1
```

— reaches a `CTEReference` node (not a base table) on the lineage walk, so it rejects
structurally with `no-base-lineage` ("not updateable in phase 1"). Pinned as a v1 boundary in
`93.4-view-mutation.sqllogic` and documented in `docs/view-updateability.md`.

## Scope

Transparent multi-level inlining: fold the chain `t → a → ml` so the write lands on `ml`,
provided every intermediate CTE is itself a single-source projection-and-filter (the same
updateability gate, applied transitively). A chain that hits a non-updateable intermediate
(aggregate, distinct, set-op, join-of-joins beyond the two-table case) still rejects with the
intermediate's body-shape diagnostic.

Lower priority than `cte-dml-halloween-self-read`. Pursue only if a real consumer needs
multi-level CTE write-through; otherwise the documented reject is an acceptable boundary.

## Acceptance

- A multi-level CTE chain of single-source projection-filter members writes through to the
  terminal base table, byte-identical to collapsing the chain into one CTE body.
- A chain with a non-updateable intermediate rejects with that intermediate's diagnostic.
- Replace the v1-boundary "multi-level rejects" assertions in `93.4-view-mutation.sqllogic`
  and the doc with the new behavior.
