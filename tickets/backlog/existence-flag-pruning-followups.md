description: Two deferred, no-correctness-impact follow-ons to `prune-unused-existence-flag` (the join existence-flag pruning rule that landed): (1) aggregate-anchored pruning of an unused flag under an AggregateNode, and (2) semijoin/anti-semijoin access-path recovery when a flag is used ONLY as a boolean `where hasP` / `where not hasP` probe.
files: packages/quereus/src/planner/rules/join/rule-join-existence-pruning.ts, packages/quereus/src/planner/rules/join/rule-join-elimination.ts (ruleJoinEliminationUnderAggregate — the mirror to copy), packages/quereus/src/planner/rules/subquery/rule-semi-join-fk-trivial.ts, packages/quereus/src/planner/rules/subquery/rule-anti-join-fk-empty.ts
----

The base rule `join-existence-pruning` (see `rule-join-existence-pruning.ts`)
drops an unused outer-join `exists … as` flag only when the join is reachable
from a `ProjectNode` through a clean `Filter`/`Sort`/`LimitOffset`/`Distinct`/
`Alias` chain. Two shapes it intentionally does not handle yet — both pure
optimizations (an unused flag under either shape is simply computed and
discarded today, exactly as before the base rule):

## 1. Aggregate-anchored pruning

When an unused flag-bearing join sits under an `AggregateNode` (not a Project),
the base rule's `walkChain` bottoms out at the Aggregate and no-ops. Mirror
`ruleJoinEliminationUnderAggregate` (same module as `ruleJoinElimination`):
a distinct entrypoint on `PlanNodeType.Aggregate` that collects demand from the
group-by expressions + every aggregate expression, runs the same `walkChain`,
and prunes flags whose attr id is not in that demand set. Small, mechanical
mirror of the Project entrypoint; defer-cost is zero (the flag is harmlessly
computed-and-discarded under the aggregate meanwhile).

## 2. Semijoin / anti-semijoin recovery

When a flag is still referenced but **only** as a pure existence probe — the
classic semijoin shape, flag consumed solely by a top-level `where hasP` /
`where not hasP` and nowhere else — the join is currently pinned to nested-loop
and forfeits the access-path choice a semi/anti join would enable. A follow-on
rewrite could recover it. This needs its own demand-*shape* analysis (the flag
used only as a boolean filter, not merely "is it demanded") and must interact
cleanly with the existing `semi-join-fk-trivial` / `anti-join-fk-empty` rules.
Promote to `plan/` when picked up — it is a design task, not a mechanical mirror.
