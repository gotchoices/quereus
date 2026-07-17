----
description: A correlated subquery inside a join's ON condition (e.g. `a join b on b.x = (select max(v) from c where c.k = a.k)`) is evaluated for every candidate row pair; extend subquery decorrelation to cover this site too.
files: packages/quereus/src/planner/rules/subquery/rule-subquery-decorrelation.ts, packages/quereus/src/planner/rules/subquery/rule-scalar-agg-decorrelation.ts, packages/quereus/src/planner/nodes/join-node.ts
----

# Decorrelate correlated subqueries in join ON conditions

## Context

The decorrelation work covers correlated subqueries in the SELECT list, WHERE,
HAVING, ORDER BY (scalar-aggregate → grouped left join) and EXISTS/IN in WHERE
and the SELECT list (→ semi/anti or existence-flag join). The one remaining
per-row site is a correlated subquery embedded in a **join ON condition**:

```
select *
from a join b on b.x = (select max(c.v) from c where c.k = a.k)
```

Here the subquery is evaluated for every `(a, b)` candidate pair the join
considers — potentially far more times than once per outer row.

## Why this is deferred (not in the current implement pass)

This site is materially harder and lower-value than the others, so it is parked
here rather than shipped alongside them:

- **Correlation can reach either side of the join** (`a` and/or `b`), not a
  single "outer". Which relation the grouped/decorrelated subtree must join
  against, and where in the join tree the new join lands, depends on which side(s)
  the subquery references — a genuinely different placement problem than the
  single-outer sites.
- **The subquery lives inside a join predicate**, not a Filter/Project/Sort/
  Aggregate expression tree, so the anchor and the rewrite (splitting the ON
  condition, re-associating joins) are new machinery, not a reuse of the existing
  `decorrelateAll`/`extractExistsCorrelation` helpers.
- **Interaction with join reordering / physical selection** is unexplored: a
  decorrelated subquery-join nested inside another join's ON condition may block
  or complicate hash/merge selection and equi-pair extraction.

## What a plan pass should resolve

- Which correlation topologies to support first (correlate to one side only is
  the tractable slice; both-sides correlation may stay per-pair).
- Where the new join lands relative to the enclosing join (below the referenced
  side? above the whole join with a rewritten condition?).
- Whether to restrict to scalar-aggregate subqueries (reuse the grouped-join
  rewrite) initially and defer EXISTS/IN-in-ON separately.
- Cost/benefit: how often this shape occurs in practice vs the plumbing cost —
  it may warrant a narrower first cut or remaining low-priority.

Promote to `plan/` when the earlier decorrelation sites have landed and this
shape is observed to matter.
