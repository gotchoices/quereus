----
description: A correlated "value" subquery used in an ORDER BY expression (e.g. `order by (select count(*) from c where c.fk = o.k)`) still re-runs the inner query once per row; rewrite it to the same grouped join, but strip the join's extra columns so the sort's output row shape is unchanged.
prereq: feat-decorrelate-scalar-subquery-where-having
files: packages/quereus/src/planner/rules/subquery/rule-scalar-agg-decorrelation.ts, packages/quereus/src/planner/optimizer.ts, packages/quereus/src/planner/nodes/sort.ts, packages/quereus/src/planner/nodes/project-node.ts, packages/quereus/test/logic/07.7-scalar-agg-decorrelation.sqllogic
difficulty: medium
----

# Decorrelate correlated scalar-aggregate subqueries in ORDER BY (SortNode)

## Background

See `feat-decorrelate-scalar-subquery-where-having` for the shared machinery
(`decorrelateAll` / `decorrelateOne` / `collectCandidates` in
`rule-scalar-agg-decorrelation.ts`). This ticket adds the ORDER BY anchor.

A correlated scalar-aggregate subquery in an ORDER BY expression —
`select o.* from o order by (select count(*) from c where c.fk = o.k)` — plans as
`Sort[ key = ScalarSubquery(...) ]( source )` and re-runs the inner pipeline once
per outer row during sort-key evaluation.

## The complication that makes this its own ticket

Unlike `ProjectNode` (which outputs only its projection columns) and
`FilterNode`/`AggregateNode`, **`SortNode` passes its source's attributes through
verbatim** — `SortNode.getAttributes()` returns `this.source.getAttributes()`
(see `nodes/sort.ts`). If we naively rewrite the source to
`LeftJoin(source, groupedAgg)`, the join's appended group-key + value columns
**leak upward** out of the Sort, changing the row shape every ancestor sees.

The Project-site rule sidesteps this because the Project consumes and hides the
join columns. The Sort site must restore the original output shape explicitly.

### Design: wrap the rewritten Sort in a pass-through Project

Emit:

```
Project[ <one bare column ref per original source attribute, ids preserved> ]
  Sort[ key = <value read> ]                 -- sort key uses the join value column
    LeftJoin[ inner.k = o.k ]
      source                                 -- original Sort source (the outer)
      Aggregate(groupBy=[inner.k], aggregates=[count(*)])
        Filter(residual inner-only preds, inner)
```

- The `LeftJoin` sits **below** the Sort so the sort key can read the value
  column.
- The wrapping `ProjectNode` re-projects exactly the original source's
  attributes (bare `ColumnReferenceNode`s, preserving attribute ids), so the
  subtree's output type/attributes are byte-identical to the original SortNode's
  — no leak, and every ancestor resolves unchanged by attribute id.

Sketch:

```
export function ruleScalarAggDecorrelationSort(node, _context): PlanNode | null {
  if (!(node instanceof SortNode)) return null;
  const candidates = collectCandidates(node.sortKeys.map(k => k.expression));
  if (candidates.length === 0) return null;
  const rewrite = decorrelateAll(candidates, node.source);
  if (!rewrite) return null;

  const newKeys = node.sortKeys.map(k => ({
    ...k,
    expression: substituteSubqueries(k.expression, rewrite.replacements),
  }));
  const newSort = new SortNode(node.scope, rewrite.source, newKeys);

  // Strip the join-added columns: re-project the ORIGINAL source attributes.
  const passthrough = node.source.getAttributes().map((attr, i) =>
    ({ node: <ColumnReferenceNode for attr, index i>, alias: attr.name, attributeId: attr.id }));
  return new ProjectNode(node.scope, newSort, passthrough, undefined,
                         node.source.getAttributes() /* preserveAttributeIds */);
}
```

Confirm the exact `ProjectNode` constructor signature and the
attribute-preservation argument against `rebuildProject` in the same file (which
already builds an id-preserving Project) — reuse its pattern rather than
re-deriving it. The passthrough column refs must carry the original source
column indices (0..n-1), because the LEFT join places the original source
columns first (left side) — the join appends its columns after, so the original
indices are still valid on the join output.

### Ordering stability

The substituted value is byte-identical to the scalar the subquery would return
(same empty-input replacement as the Filter/Project sites), and the LEFT join
matches ≤1 row per outer row (unique group keys), so row **count**, **multiplicity**,
and **per-row sort-key values** are all unchanged → sort order is identical.
`asc`/`desc`/`nulls` are copied verbatim onto the new keys.

### Registration

```
{ pass: PassId.Structural, id: 'scalar-agg-decorrelation-sort',
  nodeType: PlanNodeType.Sort, phase: 'rewrite',
  fn: ruleScalarAggDecorrelationSort, sideEffectMode: 'aware' }
```

Sort is not otherwise a decorrelation anchor, so no registration-order coupling
with the Filter/Project sites is required; place it adjacent to them for
locality.

## Edge cases & interactions

- **Sort is the top-level node (no enclosing Project):** e.g. a view body or a
  compound arm. The pass-through Project makes the output shape invariant, so
  this is safe — add a test where the ORDER BY subquery query is wrapped in a
  view / used as a compound-select arm and the column set is unchanged.
- **ORDER BY expression also appears in the SELECT list:** `select (select
  count(*) ...) as n from o order by n` vs `order by (select count(*) ...)`.
  Ensure the Sort-site and Project-site rules don't double-decorrelate or
  conflict (they operate on distinct anchors and node identities; verify the
  plan is correct and the inner is scanned once, not twice).
- **ORDER BY on an aggregate query:** `... group by o.k order by (select ...
  where c.fk = o.k)` — Sort source is the (post-HAVING) Aggregate/Filter;
  correlation to a group key resolves. Test it.
- **Empty inner group in the sort key:** miss → replacement value (count→0 /
  avg→NULL). Verify NULL ordering (`nulls first/last`) matches the correlated
  baseline.
- **Multiple ORDER BY keys, only some correlated:** substitute only the
  recognized subqueries; untouched keys pass through unchanged.
- **LIMIT/OFFSET above the Sort:** the pass-through Project sits between Sort and
  Limit — confirm Limit still applies to the correct (unchanged) row set.
- **Bail cases** (non-equi correlation, side-effecting inner, GROUP BY / limit-1
  subquery shapes): `decorrelateOne` bails; the Sort key stays correlated but
  correct.

## TODO

- Add `ruleScalarAggDecorrelationSort` to `rule-scalar-agg-decorrelation.ts`,
  reusing `rebuildProject`'s id-preserving Project pattern for the strip layer;
  export it and extend the module header to four anchors.
- Register `scalar-agg-decorrelation-sort` in `optimizer.ts`.
- Add `.sqllogic` coverage: basic ORDER BY subquery, view/compound top-level
  Sort (shape invariance), ORDER-BY-plus-SELECT-list same subquery, aggregate
  query ORDER BY, empty-group NULL ordering, multi-key partial, LIMIT above Sort,
  and a bail-but-correct case.
- Run `yarn workspace @quereus/quereus test` and `yarn lint`; stream with `tee`.
