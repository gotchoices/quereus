----
description: Correlated "value" subqueries in a WHERE or HAVING comparison now compile to a single grouped join (scanned once) instead of re-running the inner query per row; review the new optimizer rule and its output-column handling.
prereq:
files: packages/quereus/src/planner/rules/subquery/rule-scalar-agg-decorrelation.ts, packages/quereus/src/planner/optimizer.ts, packages/quereus/test/logic/07.7.1-scalar-agg-decorrelation-filter.sqllogic, packages/quereus/test/plan/scalar-agg-decorrelation.spec.ts, packages/quereus/test/vtab/correlated-scalar-agg-scan-count.spec.ts, docs/optimizer-rules.md, docs/todo.md
difficulty: medium
----

# Review: decorrelate correlated scalar-aggregate subqueries in Filter predicates (WHERE + HAVING)

## What was built

Added a third anchor to the existing `rule-scalar-agg-decorrelation.ts` (which
already decorrelated the SELECT-list and enclosing-aggregate-argument cases):

- `ruleScalarAggDecorrelationFilter` (rule id `scalar-agg-decorrelation-filter`,
  `nodeType: Filter`) — a correlated scalar-aggregate subquery used anywhere in a
  Filter predicate (WHERE, or HAVING — a HAVING clause plans as a FilterNode over
  an AggregateNode) is rewritten to `Filter[pred'](LeftJoin(outer, groupedAgg))`
  reusing the shared, anchor-agnostic `decorrelateAll` / `decorrelateOne`
  machinery. Registered in `optimizer.ts` **after** `subquery-decorrelation` (both
  are Filter-typed; pass rules fire in registration order) so EXISTS/IN semi/anti
  joins materialize first.

The inner table is now scanned/aggregated **once** instead of once per outer row.
Empty-input semantics (the "count bug") are preserved by the LEFT join + the
existing empty-value replacement (`NULL` for avg/sum/min/max, a `CASE WHEN <group
key> IS NULL …` marker for count/total), so three-valued predicate logic falls out
for free — no new correctness code.

## Deviation from the plan the reviewer MUST scrutinize

The ticket's design snippet returned a **bare** `FilterNode` over the decorrelated
source. That is **wrong** and I changed it. A FilterNode publishes its source's
attributes verbatim, so the LEFT join's appended grouped-aggregate columns
(`gk`, `min(lim.cap)`, …) leak into the query output whenever the Filter is not
already under a capping Project. That is exactly the **common HAVING shape**: when
the SELECT list equals the aggregate's outputs, the planner fuses the projection
into the AggregateNode and the HAVING Filter is the query's output node — no
Project above it. A first draft produced rows like
`{k:10, s:12, gk:10, "min(lim.cap)":3}` (verified with `query_plan()`; the HAVING
plan is `Block → Filter → HashJoin(LEFT) → [HashAggregate(ord), HashAggregate(lim)]`
with no Project).

Fix: the rule caps its own result with a bare pass-through Project
(`capToFilterAttributes`) that re-exposes exactly the original Filter attributes,
reading outer columns from the join's left side (indices `0..N-1`, unchanged
because the LEFT join places the outer on the left). The ticket's claim "every
SELECT caps its WHERE/HAVING filter with a Project (or the Aggregate below a
HAVING filter)" is false — the Aggregate is *below* the filter and cannot cap the
filter's output.

**Verify the cap:** column-index soundness rests on the LEFT join keeping outer
attributes at their original 0-based indices and `predefinedAttributes` pinning
ids/types. Confirm no consumer reads the capped Filter by anything other than
attribute id, and that the cap types (outer side, never null-extended) are right.

## Use cases / how to validate

Build + tests + lint all pass (`yarn workspace @quereus/quereus test` → 7074
passing / 0 failing; `yarn lint` clean).

New coverage:
- `test/logic/07.7.1-scalar-agg-decorrelation-filter.sqllogic` — WHERE avg
  comparison (3-valued logic via NULL-pad), WHERE count empty-group = 0 (no-match
  row survives), subquery inside a disjunction, two stacked subqueries, EXISTS +
  scalar-agg mix (both rules fire), HAVING correlating to a group key, HAVING count
  empty-group, HAVING correlating to the aggregate result, and bail-but-correct
  cases (non-equi correlation, non-aggregate LIMIT 1).
- `test/plan/scalar-agg-decorrelation.spec.ts` — new `describe` "filter site":
  asserts the Filter's source becomes a physical **LEFT** hash/merge join with the
  grouped aggregate under it, `ScalarSubquery` dissolved, disjunction/two-stack/
  EXISTS-mix shapes, bail cases stay correlated, DML-bearing inner refused
  (planning-only via `query_plan()`), and byte-identical results vs a baseline DB
  with `scalar-agg-decorrelation-filter` disabled.
- `test/vtab/correlated-scalar-agg-scan-count.spec.ts` — two new cases proving a
  WHERE-clause scalar-agg subquery scans the child **once** (and N times with the
  rule disabled, so the guard actually observes the N+1).

Manual spot-check ideas for the reviewer: run any WHERE/HAVING scalar-agg query
under `query_plan()` and confirm (a) no `ScalarSubquery`, (b) a `LEFT HASH/MERGE
JOIN`, (c) the output column set is unchanged from the correlated plan.

## Known gaps / things to poke at

- **Redundant cap Project (tripwire, recorded in code):** for a WHERE filter
  already under a SELECT Project, the cap is a redundant pass-through Project (not
  eliminated — its Filter source has more attributes than the cap outputs, so no
  trivial-project rule fires). Harmless (one extra node, correct output). Tagged
  `NOTE:` in `capToFilterAttributes`. Only becomes work if it shows up as
  plan-shape noise or in profiling.
- **HAVING correlating to the aggregate result** is tested only for *result*
  equivalence (`having sum(x) > (select count(*) … where cap = sum(x))`), not for
  whether it decorrelates vs bails. It computes correctly either way (that was the
  ticket's bar), but a reviewer wanting a structural guarantee could add a
  plan-shape assertion.
- **Side-effecting inner** is guarded and tested planning-only (`query_plan()`
  never fires the `INSERT ... RETURNING`); there is no runtime test asserting the
  write actually fires per-row when decorrelation is refused. The existing
  side-effect gate is shared with the sibling anchors, so this is low-risk.
- No test for **multiple stacked scalar-agg subqueries in a HAVING** predicate
  (only WHERE two-stacking is covered). The stacking logic is anchor-agnostic
  (`decorrelateAll`), so this is a coverage gap, not a suspected defect.
- Cost model unchanged: the rule is unconditional (no cost gate), matching the
  sibling anchors; the tiny-outer/huge-inner tradeoff remains tracked in
  `backlog/feat-decorrelation-cost-model`.

## Docs updated

`docs/optimizer-rules.md` (third anchor described on the `ruleScalarAggDecorrelation`
bullet) and `docs/todo.md` (subquery-optimization shipped list).
