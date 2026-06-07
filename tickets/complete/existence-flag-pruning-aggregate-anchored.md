description: Aggregate-anchored variant of existence-flag pruning. New optimizer entrypoint `ruleJoinExistencePruningUnderAggregate` (id `join-existence-pruning-aggregate`, Structural / Aggregate / priority 22 / `sideEffectMode: 'safe'`) drops an unused outer-join `exists … as` flag from a JoinNode reachable through a pass-through chain under an `AggregateNode` — the shape the Project-anchored base rule no-ops on. Pure optimization. Build + full quereus suite (5045 passing) + lint all green; 11 regression tests added. Reviewed and accepted with no code changes.
files: packages/quereus/src/planner/rules/join/rule-join-existence-pruning.ts, packages/quereus/src/planner/optimizer.ts, packages/quereus/test/optimizer/rule-join-existence-pruning.spec.ts, docs/optimizer.md, docs/view-updateability.md, tickets/backlog/join-elimination-aggregate-outer-join.md
----

## What landed

A second entrypoint in `rule-join-existence-pruning.ts`,
`ruleJoinExistencePruningUnderAggregate`, structurally identical to
`ruleJoinExistencePruning` except for the demand-collection prologue (group-by +
aggregate expressions — an `AggregateNode`'s only scalar children) and the
chain-rebuild epilogue (rebuilds the `AggregateNode` with `preserveAttributeIds`
so its output attr ids stay stable). It reuses the exported `collectAttrIds` /
`walkChain` / `rebuildChain` helpers from `rule-join-elimination.ts` (no logic
duplicated). Registered in `optimizer.ts` as `join-existence-pruning-aggregate`
(Structural, `PlanNodeType.Aggregate`, rewrite phase, priority 22,
`sideEffectMode: 'safe'`), mirroring the `join-elimination` / `…-aggregate`
pairing. Docs updated in `docs/optimizer.md` and `docs/view-updateability.md`.

The ticket's headline cascade ("prune the flag, then
`ruleJoinEliminationUnderAggregate` drops the join → zero join ops") is **not
achievable** and was correctly deferred: `exists … as` is parser-rejected on
inner joins, and `ruleJoinEliminationUnderAggregate` is inner-only, so pruning a
flag under an aggregate re-enables physical join selection but never elimination.
The elimination leg is filed as `tickets/backlog/join-elimination-aggregate-outer-join.md`.

## Review findings

Adversarial pass over the implement diff (commit `e1679ff0`), read fresh before
the handoff summary. Lint + build + full suite re-run green.

### Soundness — checked, no defects

- **Demand completeness of the Aggregate anchor.** Re-derived from source:
  `AggregateNode.getChildren()` is `[source, ...groupBy, ...aggregates.map(a =>
  a.expression)]` (`aggregate-node.ts:213`). The prologue scans exactly the
  group-by and aggregate expressions — the Aggregate's only scalar children — so
  a flag attr id absent from `demanded` is provably unreferenced by the Aggregate
  and every ancestor (ancestors can only see the Aggregate's *output* attrs).
  Mirrors the Project anchor and `ruleJoinEliminationUnderAggregate` verbatim.
- **Aggregate sub-expression recursion is complete.** `collectAttrIds` recurses
  via `getChildren()`. Verified `AggregateFunctionCallNode.getChildren()`
  (`aggregate-function.ts:56`) returns `[...args, filter?, ...orderBy]` — so a
  flag referenced inside an aggregate `FILTER` predicate or `ORDER BY` key (not
  just a positional arg) **is** caught and the flag retained. No unsound prune
  path here. (FILTER is in fact parser-rejected today — see below — but the
  recursion is correct regardless.)
- **HAVING.** No HAVING field on `AggregateNode`; HAVING is a `FilterNode` above
  the Aggregate that can only reference Aggregate outputs. Confirmed by the
  `having count(*) > 0` test still pruning an otherwise-unused flag.
- **Attr-id stability.** New `AggregateNode` is rebuilt with `node.getAttributes()`
  as `preserveAttributeIds` and the same `groupBy`/`aggregates` node objects (pure
  source swap); the kept join columns' attr ids are unchanged, so the group-by /
  aggregate `ColumnReferenceNode`s still resolve. Identical to
  `ruleJoinEliminationUnderAggregate`.
- **Termination.** `kept.length === existence.length ⇒ return null`; re-running on
  the rule's own output (flag-free, or all-remaining-flags-demanded) is a no-op.
  No rewrite loop.
- **`sideEffectMode: 'safe'`.** Drops only a derived read-only `{true,false}`
  column; both join sides preserved verbatim. Correct.
- **Priority / registration.** Priority 22 (Aggregate nodeType) does not collide
  with the priority-22 Project entrypoint (different nodeType). Sits before
  `join-elimination-aggregate` (26) so a freshly-pruned Aggregate threads through
  in the same `applyRules` loop. Fires on logical `AggregateNode` only (structural
  pass runs before physical aggregate selection), consistent with the elimination
  sibling.
- **Deviation rationale verified against source.** Confirmed the parser rejects
  `exists … as` on inner/cross joins (`parser.ts` `resolveExistenceSide`: "no side
  is null-extended") and `ruleJoinEliminationUnderAggregate` is inner-only
  (`if (join.joinType !== 'inner') return null;`). The "prune re-enables physical
  selection but never cascades to elimination" claim is correct. The deferred
  backlog ticket's outer-join-elimination soundness argument (LEFT preserves all L
  rows, FK→PK ⇒ `|L⋈R| == |L|`) is sound on its face; left for that ticket.
- **DRY / modularity.** Reuses the exported elimination helpers; the only added
  imports (`AggregateNode`, `isRelationalNode`) are used. No duplication.
- **Error handling.** `if (!isRelationalNode(newSource)) throw` guards the rebuild,
  matching the elimination sibling. `kept.length > 0 ? kept : undefined` correctly
  collapses `existence` to `undefined` when the last flag is dropped.

### Docs — checked, accurate

`docs/optimizer.md` (the now-dual-entrypoint `ruleJoinExistencePruning` entry,
including the explicit aggregate-anchor "does not cascade to elimination" note)
and `docs/view-updateability.md` (two-anchor existence-pruning paragraph) read
correctly against the new code. No stale references.

### Tests — checked; implementer's two "known gaps" are non-issues

The 11 added cases cover happy path (`count(*)` prune + physical-selection
re-enable), the disabled-rule contrast, result-equality vs an unpruned baseline
(new `resultsNoPruneAgg` helper disabling both anchors), retained paths
(aggregate-arg, GROUP BY key, WHERE-under-aggregate, HAVING), mixed multi-flag
middle/edge drops with runtime value checks, and a clean no-op over a bare table.

The implementer flagged two coverage gaps; both were investigated and found **not
actionable**, so no tests were added:

- **right/full outer-join flag under an aggregate.** Attempted to add a FULL-join
  case. FULL JOIN throws `FULL JOIN is not supported yet` and RIGHT JOIN throws
  `RIGHT JOIN is not supported yet` at runtime. Since `exists … as` is valid only
  on a non-preserved (null-extendable) side, the *only* executable outer-join
  shape carrying an existence flag is `LEFT … exists right as` — which the suite
  already exercises. The gap is unreachable, not a real hole. (Reverted the probe
  edit; working tree clean.)
- **aggregate `FILTER` flag-arg.** Aggregate `FILTER (WHERE …)` is parser-rejected
  today (`test/logic/07.1-aggregate-filter-clause.sqllogic` documents the
  rejection), so it cannot be tested. The underlying recursion soundness (flag in
  a non-arg aggregate sub-expression) is already exercised by the
  `sum(case when hasP …)` aggregate-arg test.

### Disposition

No minor fixes required and no major findings — the implementation is correct,
DRY, well-documented, and the test suite is adequate given the engine's join-type
support. The one genuine follow-up (outer-join elimination under a cardinality
aggregate, the deferred headline cascade) is already filed as
`tickets/backlog/join-elimination-aggregate-outer-join.md`.

`test:store` was not run — this is a pure plan-level rewrite with no storage
interaction, so the store path is not expected to differ (carried over from the
implement-stage note).

## Validation (re-run during review)

- `yarn workspace @quereus/quereus build` — exit 0.
- `yarn workspace @quereus/quereus run lint` — clean (exit 0).
- `yarn workspace @quereus/quereus test` — **5045 passing, 9 pending, 0 failing**.
- Targeted `rule-join-existence-pruning.spec.ts` — **27 passing**.
