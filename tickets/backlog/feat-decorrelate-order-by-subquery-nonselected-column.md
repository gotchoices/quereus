----
description: Speed up a query that sorts by a correlated subquery when the subquery depends on a column the query doesn't select — today that case still re-runs the inner query once per row; make it use the same one-pass grouped join the selected-column case already gets.
files: packages/quereus/src/planner/rules/subquery/rule-scalar-agg-decorrelation.ts, packages/quereus/src/planner/nodes/sort.ts, packages/quereus/src/planner/nodes/project-node.ts
----

# Decorrelate ORDER BY scalar-agg subqueries when the correlation column is projected away

## Context

`feat-decorrelate-scalar-subquery-order-by` added the Sort anchor
(`ruleScalarAggDecorrelationSort`): a correlated scalar-aggregate subquery in an
ORDER BY key is rewritten into a grouped LEFT join so the inner table is scanned
once instead of once per outer row.

That rewrite fires only when the **correlation column is present in the Sort's
own source**. Two common shapes satisfy that:

- identity projections — `select o.* from o order by (select count(*) from c where c.fk = o.k)`
- any query that also selects the correlation column — `select o.id, o.k from o order by (select count(*) from c where c.fk = o.k)`

## The gap

When the SELECT list projects the correlation column **away**, the Sort sits
above a *stripping* Project:

```
select o.id from o order by (select count(*) from c where c.fk = o.k)
```

```
Sort[ key = ScalarSubquery(... c.fk = o.k ...) ]
  Project[ o.id ]          -- o.k stripped here
    Scan o                 -- o.k lives here, below the Project
```

`decorrelateOne` requires `o.k` to be an attribute of the Sort's immediate
source, but the Project's output no longer carries it, so the rule **bails** and
the subquery stays correlated. The result is still **correct** — at runtime the
correlated `o.k` resolves from the still-live base-scan row context below the
Project (Quereus resolves correlated column refs by attribute id off a live
context stack, not off the Sort's input row) — it is merely **not optimized**:
the inner pipeline re-runs once per outer row.

## Why it is deferred

The other decorrelation sites (Project/Filter/Aggregate) consume the join's
appended columns at the anchor itself, and the working Sort cases have the
correlation column in the Sort's source. Fixing the stripped-column case means
getting the grouped **value** column from a join that must reference `o.k`
(available only *below* the stripping Project) up to the Sort key that lives
*above* the Project. That requires either:

- **Rule-level threading:** insert the LEFT join below the stripping Project,
  extend the Project (and any intervening pass-through nodes) to carry the value
  (and CASE-guard group-key) column up to the Sort, substitute in the Sort key,
  then cap back to the original output shape. The delicate part is physical
  **column-index** bookkeeping through a Project that subsets/reorders columns —
  exactly where these rewrites are easy to get subtly wrong. A same-node subquery
  that ALSO appears in the SELECT list (decorrelated by the Project site) makes
  the threading interact with an already-rewritten Project.

- **Builder-level:** teach `shouldApplyOrderByBeforeProjection`
  (`select-modifiers.ts`) to place the Sort *below* the final projection when an
  ORDER BY key is an expression (not just a bare column) that references
  non-projected columns — as it already does for a bare `order by o.k`. This is
  simpler for the rule but broadens plan shape for **all** such expression
  ORDER BYs (e.g. `order by o.k + 1`) and risks reordering interactions with a
  Project-site join over a sorted input; needs a plan pass to bound the blast
  radius.

## What a plan pass should resolve

- Rule-level threading vs builder-level Sort placement (and the ordering-safety
  proof if a join lands over/under the Sort).
- Whether to restrict the first cut to a single bare pass-through Project (the
  overwhelmingly common `select <subset of columns>` case) and bail on
  computing/aliasing Projects.
- How it composes with the Project-site rule when the same subquery shape is in
  both the SELECT list and the ORDER BY.

Promote to `plan/` if this shape is observed to matter; until then the query is
correct, just not decorrelated.

## Prior art / anchors

- `ruleScalarAggDecorrelationSort` and `capToAttributes` in
  `packages/quereus/src/planner/rules/subquery/rule-scalar-agg-decorrelation.ts`
  (see the `SCOPE:` note in the module header and the `NOTE:` at the rule site).
- The bail is pinned by tests: `test/plan/scalar-agg-decorrelation.spec.ts`
  ("leaves the subquery correlated when the correlation column is projected
  away") and a case in `test/logic/07.7-scalar-agg-decorrelation.sqllogic`.
