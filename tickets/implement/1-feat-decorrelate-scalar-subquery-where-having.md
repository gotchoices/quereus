----
description: Correlated "value" subqueries used in a WHERE or HAVING comparison (e.g. `where o.total > (select avg(amount) from c where c.fk = o.k)`) still re-run the whole inner query once per row; rewrite them to a single grouped join like the SELECT-list case already does.
prereq:
files: packages/quereus/src/planner/rules/subquery/rule-scalar-agg-decorrelation.ts, packages/quereus/src/planner/optimizer.ts, packages/quereus/src/planner/nodes/filter.ts, packages/quereus/test/logic/07.7-scalar-agg-decorrelation.sqllogic
difficulty: medium
----

# Decorrelate correlated scalar-aggregate subqueries in Filter predicates (WHERE + HAVING)

## Background

`rule-scalar-agg-decorrelation.ts` already rewrites a correlated scalar-aggregate
subquery — `(select agg(x) from inner where inner.k = outer.a)` — into a grouped
LEFT JOIN so the inner table is scanned/aggregated once instead of once per outer
row. Today it fires at two anchors:

- `ruleScalarAggDecorrelation` — subqueries in a `ProjectNode`'s projection
  expressions (SELECT list).
- `ruleScalarAggDecorrelationAggregate` — subqueries inside an `AggregateNode`'s
  aggregate-argument / group-by expressions.

The per-subquery rewrite `decorrelateOne` (and its driver `decorrelateAll` and
collector `collectCandidates`) is **anchor-agnostic**: given a set of candidate
`ScalarSubqueryNode`s and an outer `RelationalPlanNode`, it returns a
`{ source, replacements }` pair — a join-stacked source plus a map from each
subquery node to the scalar expression that replaces it (a bare value-column read,
or a `CASE WHEN <group key> IS NULL THEN <empty literal> ELSE <value> END` guard
for aggregates whose empty-input value is non-NULL, e.g. `count`/`total`).

## What's still per-row

A correlated scalar-aggregate subquery in a **WHERE comparison** —
`where o.total > (select avg(c.amount) from c where c.fk = o.k)` — plans as
`Filter[ o.total > ScalarSubquery(...) ]( outer )` and re-executes the inner
pipeline for every outer row the filter evaluates.

**HAVING is the same shape**: `... group by o.k having sum(o.v) > (select ...)`
plans as `Filter[having_pred]( Aggregate(...) )`. The Filter's source is the
Aggregate, whose output attributes include the group keys (and aggregate
results) the subquery correlates to. A single Filter-anchored rule covers both
WHERE and HAVING with no special-casing — HAVING is just a FilterNode whose
source happens to be an Aggregate.

## Design

Add a third exported anchor in `rule-scalar-agg-decorrelation.ts`:

```
export function ruleScalarAggDecorrelationFilter(node, _context): PlanNode | null {
  if (!(node instanceof FilterNode)) return null;
  const candidates = collectCandidates([node.predicate]);   // single scalar tree
  if (candidates.length === 0) return null;
  const rewrite = decorrelateAll(candidates, node.source);
  if (!rewrite) return null;
  return new FilterNode(
    node.scope,
    rewrite.source,                                          // outer + stacked LEFT JOIN(s)
    substituteSubqueries(node.predicate, rewrite.replacements),
  );
}
```

Result shape (single subquery):

```
Filter[ o.total > <value read> ]
  LeftJoin[ inner.k = o.k ]                 -- correlation conjuncts, verbatim
    outer
    Aggregate(groupBy=[inner.k], aggregates=[avg(c.amount)])
      Filter(residual inner-only preds, inner)
```

The LEFT (not inner) join is load-bearing: an outer row with **no** inner match
must survive with the subquery's empty-input value, exactly as the correlated
plan produces it. `decorrelateOne` already emits the correct replacement for
that miss (NULL for avg/sum/min/max; the CASE guard for count/total), so
three-valued predicate logic is preserved automatically — the substituted value
is byte-identical to the scalar the subquery would have returned, so
`o.total > NULL` → NULL → row excluded, `o.total > 0` (empty count) evaluates
against the guarded 0, etc. **No new three-valued-logic code is required**; the
correctness comes entirely from LEFT-join preservation + the existing
empty-value replacement.

### Registration

Register in `optimizer.ts` adjacent to `subquery-decorrelation` (the EXISTS/IN
Filter rule) and `scalar-agg-decorrelation`:

```
{ pass: PassId.Structural, id: 'scalar-agg-decorrelation-filter',
  nodeType: PlanNodeType.Filter, phase: 'rewrite',
  fn: ruleScalarAggDecorrelationFilter, sideEffectMode: 'aware' }
```

`sideEffectMode: 'aware'` matches the sibling anchors — `decorrelateOne` already
bails via `PlanNodeCharacteristics.subtreeHasSideEffects` on an impure inner, but
the framework mode must still declare the execution-count change.

Two Filter-typed rules now coexist (`subquery-decorrelation` and this one). They
target disjoint subquery node types (`ExistsNode`/`InNode` top-level conjuncts vs
`ScalarSubqueryNode` anywhere in the predicate tree), so there is no match
collision; a predicate carrying both is converged over successive applyRules
iterations. Place this rule AFTER `subquery-decorrelation` in registration order
(pass rules fire in registration order) so EXISTS/IN semi/anti joins materialize
first and this rule then decorrelates any scalar-agg comparison over the
already-rewritten source (whose source may now be a JoinNode — `decorrelateOne`
treats any `RelationalPlanNode` as the outer, so that is fine).

## Edge cases & interactions

- **Empty inner group (the count bug):** miss → LEFT-join NULL-pad → replacement
  reproduces `count`→0 / `avg`→NULL. Assert a query whose correlation key has
  no inner rows returns the row (not dropped) with the right value.
- **HAVING correlating to a group key:** `group by o.k having o.k > (select
  min(c.v) from c where c.fk = o.k)`. Outer = AggregateNode; correlation attr is
  a group-key output attribute → resolves. Add a HAVING test explicitly.
- **HAVING correlating to an aggregate result:** `having sum(o.v) > (select ...
  where c.total = sum(o.v))` — the correlated column is the aggregate's own
  output attribute. Valid but unusual; confirm it either decorrelates correctly
  or bails cleanly (never miscomputes).
- **Subquery inside a disjunction:** `where a = 1 or o.x > (select ...)`. The
  LEFT join is unconditional and matches ≤1 row per outer row (group keys are a
  unique key on the grouped output), so outer multiplicity is preserved; the
  substituted value drives the OR correctly. Add a test.
- **Multiple scalar-agg subqueries in one predicate:** `decorrelateAll` stacks
  one LEFT join per recognized subquery, left-deep on the outer. Test two.
- **Both EXISTS and a scalar-agg comparison in the same WHERE:** exercise
  `where exists(...) and o.x > (select avg ...)` — both rules must fire and the
  result must be correct regardless of which fires first.
- **Non-equi / non-value-faithful correlation:** `where o.x > (select avg(v)
  from c where c.ts < o.ts)` and NOCASE/cross-affinity correlation → `decorrelateOne`
  already bails; the subquery stays correlated (still correct, just not
  optimized). Add a "stays correlated but correct" test.
- **Side-effecting inner:** a subquery whose inner subtree carries a write must
  keep per-row firing (bail). Covered by the existing side-effect gate; add a
  guard test.
- **GROUP BY / Sort / LimitOffset / multi-aggregate subquery shapes:**
  `decorrelateOne` bails on all of these (keeps today's behavior including the
  >1-row scalar-subquery runtime error). No new handling; confirm a
  `having x > (select v from c where c.fk=o.k limit 1)` non-aggregate shape is
  untouched.

## TODO

- Add `ruleScalarAggDecorrelationFilter` to `rule-scalar-agg-decorrelation.ts`;
  export it and extend the module header's "match sites" note to three anchors.
- Register `scalar-agg-decorrelation-filter` in `optimizer.ts` after
  `subquery-decorrelation`, with a comment mirroring the sibling entries.
- Add `.sqllogic` coverage (extend `07.7-scalar-agg-decorrelation.sqllogic` or a
  new `07.7.x` file): WHERE comparison, HAVING comparison, empty-group value,
  disjunction, two-subquery stacking, EXISTS-plus-scalar-agg mix, and the
  bail-but-correct cases (non-equi, side-effecting, limit-1 non-aggregate).
- If a plan-shape assertion harness exists for the sibling anchors
  (`test/optimizer/decorrelation-analysis.spec.ts`), add a case asserting the
  Filter's source becomes a LEFT JoinNode (join materialized, inner scanned once).
- Run `yarn workspace @quereus/quereus test` and `yarn lint`; stream output with
  `tee`.
