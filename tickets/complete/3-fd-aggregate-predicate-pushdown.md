description: Aggregate predicate pushdown — first FD-machinery consumer
files:
  - packages/quereus/src/planner/rules/predicate/rule-aggregate-predicate-pushdown.ts
  - packages/quereus/src/planner/analysis/predicate-conjuncts.ts
  - packages/quereus/src/planner/optimizer.ts
  - packages/quereus/src/planner/rules/subquery/rule-subquery-decorrelation.ts
  - packages/quereus/test/optimizer/rule-aggregate-predicate-pushdown.spec.ts
  - packages/quereus/test/logic/07-aggregates.sqllogic
  - docs/optimizer.md
----

## What landed

`ruleAggregatePredicatePushdown` (Structural pass, priority 19 — runs before the cross-node `rulePredicatePushdown` at 20). For a `FilterNode` directly above an `AggregateNode | StreamAggregateNode | HashAggregateNode`:

- Skips scalar aggregates (`groupBy.length === 0`).
- Builds an `outputAttrId → { sourceAttrId, sourceColIdx }` map for each bare-`ColumnReferenceNode` GROUP BY output.
- Seeds the pushable set with those output indices and widens it via `computeClosure(seed, agg.physical.fds)` — the first consumer of `physical.fds`.
- Normalizes and splits the predicate into conjuncts. A conjunct is pushable iff every column reference it carries maps to a pushable output index that has a source mapping.
- Rewrites pushable conjuncts by rebinding output `ColumnReferenceNode`s to source ones (`expr.scope`, `expr.expression`, `srcAttr.type`, source attrId, source columnIndex), wraps `agg.source` in a new `FilterNode`, and rebuilds the aggregate via direct constructor with `preserveAttributeIds = this.getAttributes()` so the residual outer Filter's column refs still resolve.
- If conjuncts remain above, a residual `FilterNode` wraps the new aggregate.

Subsumes WHERE-on-group-by-column and HAVING-on-group-by-column (HAVING is a `FilterNode` directly above the aggregate by the time the rule sees it).

`splitConjuncts` / `combineConjuncts` were extracted to `packages/quereus/src/planner/analysis/predicate-conjuncts.ts` and the subquery-decorrelation rule was migrated to use them.

## Use cases / testing

`packages/quereus/test/optimizer/rule-aggregate-predicate-pushdown.spec.ts` — 7 cases over a memory-backed `orders(id, customer_id, region, total)` plus a hash-aggregate-routed `u(grp, val)`:

- WHERE on a GROUP BY column → full pushdown (no Filter above the aggregate).
- HAVING on a GROUP BY column → full pushdown.
- HAVING on `sum(total)` → rule does not fire; Filter stays above.
- Mixed `HAVING grp-col > C AND sum(...) > C` → split.
- Non-bare GROUP BY (`group by customer_id + 1`) → rule does not fire.
- Hash-aggregate route (no index on grouping column) → predicate still pushes below.
- Scalar aggregate (no GROUP BY) + HAVING → rule does not fire.

Plan-shape assertions use `query_plan(?)` and check the index of `FILTER` vs `STREAMAGGREGATE`/`HASHAGGREGATE` in parent-first traversal.

`packages/quereus/test/logic/07-aggregates.sqllogic` gained two regression rows guarding result-set drift across the rewrite: a `HAVING grp > 'a'` case and a mixed `HAVING grp >= 'b' AND sum(val) > 40` case.

## Validation

- `yarn workspace @quereus/quereus run lint` — clean.
- `yarn workspace @quereus/quereus run test` — 2818 passing, 2 pending; the new spec's 7 cases all pass; full logic suite green.

## Docs

- `docs/optimizer.md` — rule entry under "Predicate" and a cross-reference under "Functional Dependency Tracking" noting this rule as the first `physical.fds` consumer via `computeClosure`.

## Follow-ups (not in scope)

Three other call sites still walk AND-trees inline and could migrate to the shared `splitConjuncts`/`combineConjuncts` helpers for DRY:

- `packages/quereus/src/planner/rules/join/rule-lateral-top1-asof.ts` (around L127)
- `packages/quereus/src/planner/rules/join/equi-pair-extractor.ts` (around L143)
- `packages/quereus/src/planner/rules/join/rule-quickpick-enumeration.ts` (around L59 — interleaves split with `=`-matching; partial migration only)

The FD-closure widening in this rule is currently a no-op tighter than the bare-column GROUP BY check (because `propagateAggregateFds` only projects FDs whose members all map to bare-column GROUP BY outputs). It is the correct shape for composition with future rules that widen `agg.physical.fds`.
