description: Aggregate-anchored variant of `join-existence-pruning` — drop an unused `exists … as` flag from a JoinNode reachable through a clean pass-through chain under an `AggregateNode` (today the base rule, anchored only on `ProjectNode`, no-ops on this shape). Pure optimization; an unused flag under an Aggregate is harmlessly computed-and-discarded meanwhile.
files: packages/quereus/src/planner/rules/join/rule-join-existence-pruning.ts, packages/quereus/src/planner/rules/join/rule-join-elimination.ts (ruleJoinEliminationUnderAggregate — the exact mirror to copy; collectAttrIds/walkChain/rebuildChain are exported here), packages/quereus/src/planner/nodes/aggregate-node.ts (constructor signature), packages/quereus/src/planner/optimizer.ts (rule registration, ~line 365 for the Project existence-pruning entry; ~line 460 for join-elimination-aggregate), packages/quereus/test/optimizer/rule-join-existence-pruning.spec.ts
----

## Background

`ruleJoinExistencePruning` (`rule-join-existence-pruning.ts`) drops an unused
outer-join existence flag by firing on a `ProjectNode`, collecting demanded attr
ids from the projections, `walkChain`-ing the whitelisted pass-through chain
(Filter / Sort / LimitOffset / Distinct / Alias) down to the first `JoinNode`,
and rebuilding the join without the `ExistenceColumnSpec`s whose `attrId` is not
demanded. When the last spec is dropped, `hasExistenceColumns` flips false and
the five flag-guarded join rules (join-elimination, fanout-lookup-join,
join-physical-selection, monotonic-merge-join, lateral-top1-asof) re-enable on
the now flag-free join in the same pass.

When the flag-bearing join instead sits under an **`AggregateNode`** (the
Aggregate is `walkChain`'s root, or sits at the top of the chain), the base rule
never fires — its entrypoint is `instanceof ProjectNode` only — so an unused flag
is computed and discarded under the aggregate, pinning the join to its
nested-loop shape and blocking the downstream rules (including
`ruleJoinEliminationUnderAggregate`, the aggregate variant of join-elimination
that would otherwise drop an FK-covered inner join feeding a `count(*)`).

This is the exact same situation `ruleJoinElimination` (Project) vs
`ruleJoinEliminationUnderAggregate` (Aggregate) already handle. We mirror that
split for existence pruning.

## Design (resolved — mechanical mirror)

Add a second entrypoint `ruleJoinExistencePruningUnderAggregate(node, context)`
in `rule-join-existence-pruning.ts`, structurally identical to the existing
`ruleJoinExistencePruning` except for the demand-collection prologue and the
chain-rebuild epilogue, both copied verbatim from
`ruleJoinEliminationUnderAggregate`:

```ts
export function ruleJoinExistencePruningUnderAggregate(node: PlanNode, _context: OptContext): PlanNode | null {
  if (!(node instanceof AggregateNode)) return null;

  const demanded = new Set<number>();
  for (const groupExpr of node.groupBy) collectAttrIds(groupExpr, demanded);
  for (const agg of node.aggregates) collectAttrIds(agg.expression, demanded);

  const walk = walkChain(node.source, demanded);
  if (!walk) return null;

  const { join, chain } = walk;
  if (!join.hasExistenceColumns) return null;

  const existence = join.existence!;
  const kept = existence.filter(spec => demanded.has(spec.attrId));
  if (kept.length === existence.length) return null; // every flag demanded — nothing to prune

  const newJoin = new JoinNode(
    join.scope, join.left, join.right, join.joinType,
    join.condition, join.usingColumns,
    kept.length > 0 ? kept : undefined,
  );

  const newSource = rebuildChain(chain, newJoin);
  if (!isRelationalNode(newSource)) {
    throw new Error('rule-join-existence-pruning-aggregate: rebuilt source must be relational');
  }
  return new AggregateNode(
    node.scope,
    newSource,
    node.groupBy,
    node.aggregates,
    undefined,             // estimatedCostOverride
    node.getAttributes(),  // preserveAttributeIds — keep the Aggregate's output attr ids stable
  );
}
```

New imports in `rule-join-existence-pruning.ts`: `AggregateNode` from
`../../nodes/aggregate-node.js` and `isRelationalNode` from
`../../nodes/plan-node.js` (the existing file imports only `PlanNode` /
`RelationalPlanNode` types and `ProjectNode` / `JoinNode`).

### Why the demand set is complete and the prune is provably safe

`AggregateNode.getChildren()` is `[source, ...groupBy, ...aggregates.map(a => a.expression)]`.
The only scalar children — hence the only places a `ColumnReferenceNode` to the
flag's attr id can appear — are the group-by expressions and the aggregate
expressions. So collecting demand from exactly those two sets is the complete
closure, the same property the Project entrypoint relies on (a Project can only
reference attr ids through its projection expressions). A flag attr id absent
from `demanded` is provably unreferenced by the Aggregate and everything above
it (anything above the Aggregate can only reference the Aggregate's *output*
attrs — group keys and aggregate results — never the raw flag column).

`AggregateNode` carries **no HAVING field** (constructor is
`(scope, source, groupBy, aggregates, estimatedCostOverride?, preserveAttributeIds?)`).
HAVING is a `FilterNode` *above* the Aggregate; it can only reference the
Aggregate's outputs, never the raw flag — so it needs no special handling, matching
`ruleJoinEliminationUnderAggregate` exactly.

The runtime-safety argument for dropping even a *middle* flag (attr-id-based row
resolution via the rebuilt `RowDescriptor`, kept flags' relative order
preserved) is identical to the Project case — see the base rule's module
docstring; nothing about the aggregate anchor changes it.

`sideEffectMode: 'safe'` — same as the Project existence-pruning rule: the
rewrite drops only a derived, read-only `{true,false}` boolean column; both join
sides are preserved verbatim, so no write can be skipped or reordered. (The
Aggregate is reconstructed with identical `groupBy` / `aggregates` / output
attrs — purely a source swap.)

### Registration (optimizer.ts)

Register alongside the existing existence-pruning entry, in `PassId.Structural`,
`phase: 'rewrite'`, `nodeType: PlanNodeType.Aggregate`:

```ts
this.passManager.addRuleToPass(PassId.Structural, {
  id: 'join-existence-pruning-aggregate',
  nodeType: PlanNodeType.Aggregate,
  phase: 'rewrite',
  fn: ruleJoinExistencePruningUnderAggregate,
  priority: 22,             // mirrors the Project existence-pruning priority
  sideEffectMode: 'safe',
});
```

Priority `22` places it before `join-elimination-aggregate` (priority 26) so a
freshly-pruned Aggregate threads into that rule in the same `applyRules` loop —
the aggregate-side analogue of why the Project existence-pruning (22) runs
before join-elimination (24). Update the import on optimizer.ts ~line 34 to also
pull `ruleJoinExistencePruningUnderAggregate` from
`./rules/join/rule-join-existence-pruning.js`.

## Edge cases & interactions

- **Cascade into `join-elimination-aggregate`.** The headline win:
  `select count(*) from orders left join customers on … exists right as hasC`
  (FK→PK, customer cols otherwise unreferenced). Pruning `hasC` flips the join
  flag-free, then `ruleJoinEliminationUnderAggregate` drops the join entirely →
  zero join ops. Verify both the prune *and* the subsequent elimination land in
  one optimize pass.
- **Flag demanded by an aggregate argument** (e.g. `sum(case when hasC then 1 else 0 end)`,
  or `count(*) filter (where hasC)` if supported) → `collectAttrIds` over the
  aggregate expression marks it demanded → flag retained, join stays
  nested-loop. Confirm the flag survives and reads correctly.
- **Flag demanded by a group-by key** (`group by hasC`) → demanded → retained;
  grouping reads the correct boolean.
- **Flag referenced only by a HAVING `FilterNode` above the Aggregate.** HAVING
  can only reference the Aggregate's outputs; if a query writes `having
  count(*) > 0` the flag is not referenced and is correctly pruned. There is no
  shape where HAVING references the raw flag without it also being a group key
  or aggregate argument (already covered) — assert a HAVING-bearing query still
  prunes an otherwise-unused flag.
- **Multi-flag mixed demand under an Aggregate** (e.g. two `exists right as
  hasA, hasB`, only `hasB` used inside an aggregate). The kept flag's runtime
  slot shifts; pins attr-id-based resolution exactly like the Project
  three-flag/middle-flag tests. Cover drop-earlier-keep-later and
  keep-middle-drop-both-ends.
- **`walkChain` does not reach a Join** (Aggregate directly over a base table /
  no join) → `walk` null or `hasExistenceColumns` false → clean no-op.
- **Chain with intervening Filter/Sort under the Aggregate** — `walkChain`
  already folds their referenced attrs into `demanded`; a flag used only by an
  intervening `where hasC` under the Aggregate must be retained. Mirror the
  base rule's "retained when referenced only in a WHERE/ORDER BY" cases but with
  the Aggregate as the anchor.
- **Result equality vs disabled-rule baseline.** As with the Project tests, the
  pruned plan must return byte-identical rows to the plan with
  `join-existence-pruning-aggregate` (and `join-existence-pruning`) disabled.
- **Interaction with the Project rule.** A `Project` over an `Aggregate` over a
  flag-bearing join: the Project rule fires on the Project but `walkChain` stops
  at the Aggregate (not a whitelisted pass-through) and no-ops; the Aggregate
  rule then handles it. Confirm there's no double-fire / no infinite-rewrite
  loop (each rule produces a structurally-changed node only when it actually
  drops a spec; `kept.length === existence.length` guards re-fire).

## TODO

- Add `ruleJoinExistencePruningUnderAggregate` to `rule-join-existence-pruning.ts`
  (new imports: `AggregateNode`, `isRelationalNode`).
- Update the module docstring's opening paragraph to note the rule now has two
  entrypoints (Project and Aggregate), so the next reader isn't surprised.
- Register `join-existence-pruning-aggregate` in optimizer.ts (priority 22,
  `nodeType: PlanNodeType.Aggregate`, `sideEffectMode: 'safe'`) and extend the
  existing import line.
- Add tests to `test/optimizer/rule-join-existence-pruning.spec.ts` under a new
  `describe('aggregate-anchored pruning')` block covering the edge cases above —
  reuse the existing `setupFkOrders` / `setupNonEliminable` / `seedExisting`
  helpers and the `joinExistence` / `joinCount` / `resultsNoPrune` plumbing.
  Key assertions:
    - `count(*)` over FK→PK left join with an unused flag → `joinCount === 0`
      (pruned then eliminated), rows equal baseline.
    - flag used inside an aggregate arg / group key → `joinExistence` retains it,
      values correct.
    - mixed multi-flag drop/keep with correct values for the surviving flag.
    - result equality vs `join-existence-pruning-aggregate`-disabled baseline.
- `yarn workspace @quereus/quereus test` (and lint) green before handoff.
