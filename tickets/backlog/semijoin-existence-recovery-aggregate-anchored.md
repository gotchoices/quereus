description: Aggregate-anchored variant of `semijoin-existence-recovery`. The base rule anchors on `ProjectNode`; this adds a second entrypoint anchored on `AggregateNode` for the flag-bearing `left join … exists right as <flag>` that sits under a `count(*)` / `group by` with no enclosing Project (e.g. `select count(*) from child c left join parent p on … exists right as hasP where hasP`). The probe Filter sits between the Aggregate and the Join, so the same probe-detection + chain-rewrite logic applies; only the demand prologue (group-by + aggregate expressions — the Aggregate's only scalar children) and the rebuild epilogue (reconstruct the Aggregate with `preserveAttributeIds`) differ. Mirrors how `existence-flag-pruning-aggregate-anchored` extended `join-existence-pruning`.
prereq: semijoin-existence-recovery
files: packages/quereus/src/planner/rules/join/rule-semijoin-existence-recovery.ts, packages/quereus/src/planner/rules/join/rule-join-elimination.ts (ruleJoinEliminationUnderAggregate as the prologue/epilogue precedent), packages/quereus/src/planner/optimizer.ts, packages/quereus/test/optimizer/rule-semijoin-existence-recovery.spec.ts
----

## Why deferred

Split out of `semijoin-existence-recovery` to keep that ticket to one agent run.
The Project anchor covers the dominant real-world shape (`select c.* … where
hasP`); the `count(*) … where hasP` shape is niche. The base rule's `chainWalk`
is to be written anchor-agnostic, so this follow-up is a small mirror.

## Scope

- Add `ruleSemijoinExistenceRecoveryUnderAggregate` to the same module, demand
  prologue = group-by exprs + each aggregate expression (see
  `ruleJoinEliminationUnderAggregate` / `ruleJoinExistencePruningUnderAggregate`
  for the exact `AggregateNode` child set and the `preserveAttributeIds` rebuild).
- Register at the same priority as the Project entrypoint (different `nodeType`,
  no collision), inside the 22<p<26 window.
- Tests: `count(*) … where hasP` → semi recovery + physical selection re-enable;
  `count(*) … where not hasP` → anti; HAVING-above-Aggregate does not block;
  result-equality vs a both-anchors-disabled baseline.

## Reachability note

As with the Project anchor, only `left … exists right as` is runtime-executable
(RIGHT/FULL throw, inner/cross are parser-rejected). The cardinality-elimination
cascade that the aggregate `join-elimination` sibling chases is inner-only and
does NOT apply here; the win is re-enabled physical join selection + the IND
folders, same as the Project anchor.
