----
description: Correlated subqueries in WHERE/HAVING/ORDER BY comparisons, EXISTS/IN appearing in the SELECT list, and subqueries in join conditions still run once per row; extend the decorrelation rewrites to cover those sites.
prereq: quereus-decorrelate-scalar-agg-subquery-project
files: packages/quereus/src/planner/rules/subquery/rule-subquery-decorrelation.ts, packages/quereus/src/planner/rules/subquery/rule-scalar-agg-decorrelation.ts, packages/quereus/src/planner/optimizer.ts
----

# Decorrelate correlated subqueries at the remaining expression sites

Current coverage after the in-flight grouped-join work:

- EXISTS / NOT EXISTS / IN in **WHERE** → semi/anti joins
  (`rule-subquery-decorrelation.ts`, fires on `PlanNodeType.Filter` only).
- Correlated scalar-aggregate subqueries in the **SELECT list** (and, with the
  nested ticket, aggregate arguments) → grouped left joins.

Still per-row (each re-runs its full inner pipeline for every row evaluated):

- Correlated scalar subqueries in **WHERE comparisons** —
  `where x > (select avg(v) from c where c.fk = o.k)` — the classic
  decorrelation textbook case; same grouped-join rewrite applies, joined below
  the filter.
- Correlated scalar subqueries in **HAVING** and **ORDER BY** expressions.
- **EXISTS / IN in the SELECT list** — `select exists(select ...) as flag` —
  the semi-join rewrite has an existence-column form (`hasExistenceColumns` on
  `JoinNode`) that could serve here.
- Subqueries in **join ON conditions** (per row-pair today).

Each site reuses the recognition/extraction/remap/empty-group machinery built
by the prerequisite; the work is match-site plumbing plus per-site correctness
(three-valued logic for predicates, ordering stability for ORDER BY).

Split per site when promoted; WHERE-comparison is the highest-value slice.
