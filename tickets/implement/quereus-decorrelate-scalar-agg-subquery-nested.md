----
description: Extends the new grouped-join rewrite so aggregate subqueries nested inside other aggregate subqueries (parent → child → grandchild JSON trees) also become set-based, instead of only the outermost level.
prereq: quereus-decorrelate-scalar-agg-subquery-project
files: packages/quereus/src/planner/rules/subquery/rule-scalar-agg-decorrelation.ts, packages/quereus/src/planner/optimizer.ts, packages/quereus/src/planner/nodes/aggregate-node.ts, packages/quereus/docs/optimizer.md
difficulty: hard
----

# Decorrelate scalar-aggregate subqueries nested in aggregate arguments

## Problem

The prerequisite ticket decorrelates correlated scalar-aggregate subqueries
found in a `ProjectNode`'s projection list. The motivating query (from the
original perf report) is **two levels deep**:

```sql
select e.id,
  (select json_group_array(json_object(
     'itemId', i.id,
     'quantifiers', (
        select json_group_array(json_object('id', q.id, 'value', qv.value))
        from log_entry_quantifier_values qv
        join item_quantifiers q on q.id = qv.quantifier_id
        where qv.entry_id = e.id and qv.item_id = i.id)))   -- level 2
   from log_entry_items lei
   join items i on i.id = lei.item_id
   where lei.entry_id = e.id) as items                      -- level 1
from log_entries e;
```

After the level-1 rewrite (with its outer-reference remap turning
`qv.entry_id = e.id` into `qv.entry_id = lei.entry_id`), the level-2 subquery
sits inside a `json_group_array` **aggregate argument** on the level-1
`AggregateNode` — a site the Project-level rule never visits. Without this
ticket, level 2 still executes once per (entry, item) pair and the benchmark
only partially closes the ~26× gap.

## Transformation

Same grouped-join rewrite, but the join lands **below the aggregate**:

```
Aggregate(groupBy=[...], aggregates=[agg(expr containing ScalarSubquery)])
  source
```
becomes
```
Aggregate(groupBy=[...], aggregates=[agg(expr with subquery → CASE/colref)])
  LeftJoin[source.a = g.k]
    source
    g = Project[k..., val, __present] Aggregate(groupBy=[k...], ...) Filter(rest, inner)
```

**Cardinality safety** — inserting a join below an aggregate must not change
group contents. The grouped subtree's GROUP BY keys are a unique key on its
output, so the left join matches **at most one** row per source row: row count
and multiplicity are preserved exactly, and every existing group-by/aggregate
reference resolves unchanged by attribute ID.

## Scope

- Recognition, extraction, remap, empty-group marker: identical gates to the
  prerequisite — reuse its helpers verbatim; this ticket adds only the new
  match site and join placement.
- Match site: scalar expression trees of `AggregateNode.aggregates[*]` (and
  `groupBy` expressions, though a correlated aggregate subquery as a group key
  is pathological — support falls out for free or bail explicitly).
- Register the same rule function (or a thin sibling) for
  `PlanNodeType.Aggregate` in the Structural pass, adjacent to the Project
  entry. Structural-time aggregates are still logical `AggregateNode`s.
- Iterative convergence: after the Project-level rule fires on the outer query,
  the optimizer's rewrite pass must revisit the newly built grouped subtree so
  this rule can fire on the level-1 aggregate within it. Verify the framework
  re-walks rewritten subtrees (the existing rules rely on this); if it does
  not, drive the nested rewrite from within the level-1 rewrite.

## Edge cases & interactions

- **Three-plus levels of nesting** — the rewrite must converge level by level;
  add a 3-level test.
- **Sibling subqueries at the same nesting level** — two subqueries inside one
  aggregate argument each get their own join; deterministic order.
- **Level-2 correlation spanning two ancestor levels** (`qv.entry_id = e.id
  and qv.item_id = i.id`) — only decorrelatable **after** level-1's remap makes
  both references local. If remap bailed at level 1 (weak collation etc.),
  level 2 must remain correlated and correct.
- **Join below aggregate vs group-by attribute IDs** — group-by column
  references must resolve identically post-rewrite; a golden plan guards this.
- **HAVING** — evaluated against aggregate output; the below-aggregate join
  must not disturb it.
- **DISTINCT aggregates** (`count(distinct x)`) — at-most-one join adds no
  duplicate rows, so distinct sets are unchanged; test anyway.
- **Empty level-1 group containing the level-2 read** — an entry with items
  but no quantifier values must produce `'[]'` per item; an entry with no items
  produces `'[]'` at level 1 and level 2 never evaluates.
- **Side-effect gate** — a DML-bearing nested subquery blocks only its own
  rewrite, not the enclosing level's.
- **Stream vs hash aggregate selection** — physical selection for the level-1
  aggregate happens after this structural rewrite; confirm ordering
  requirements (stream aggregate needs sorted input) still hold with the new
  join below it.

## Tests

- sqllogic: full 3-table hierarchy mirroring the original perf report (entries
  → items → quantifier values, `json_group_array(json_object(...))` at both
  levels), including entries with no items and items with no quantifier
  values; results byte-identical to the correlated baseline.
- 3-level nesting case.
- Golden plan: fully decorrelated 2-level shape — two grouped aggregates, two
  left equi-joins, zero remaining `ScalarSubquery` nodes, hash/merge physical
  joins.
- Regression: remap-bailed level 1 keeps both levels correct.
- Full suite green.

## Docs

Extend the `docs/optimizer.md` section from the prerequisite with the
aggregate-argument site and the nested convergence behavior.

## TODO

- Add `PlanNodeType.Aggregate` match site reusing the prerequisite's helpers
- Below-aggregate join placement with attribute-preservation
- Verify optimizer re-walk drives multi-level convergence
- sqllogic + golden plan tests per above
- Update `docs/optimizer.md`
- Run `yarn lint` and `yarn test`
