----
description: A query that sorts by a correlated aggregate subquery (e.g. `order by (select count(*) from c where c.fk = o.k)`) used to re-run the inner query once per row; it is now rewritten to the same one-pass grouped left join the SELECT/WHERE sites already use, with a pass-through projection so the sort's output columns are unchanged. Review the new ORDER BY anchor, its scope limits, and the test coverage.
files: packages/quereus/src/planner/rules/subquery/rule-scalar-agg-decorrelation.ts, packages/quereus/src/planner/optimizer.ts, packages/quereus/test/plan/scalar-agg-decorrelation.spec.ts, packages/quereus/test/vtab/correlated-scalar-agg-scan-count.spec.ts, packages/quereus/test/logic/07.7-scalar-agg-decorrelation.sqllogic, docs/optimizer-rules.md
difficulty: medium
----

# Review: decorrelate correlated scalar-aggregate subqueries in ORDER BY (Sort anchor)

## What was built

A fourth match site for the scalar-aggregate decorrelation rule:
`ruleScalarAggDecorrelationSort` (id `scalar-agg-decorrelation-sort`, anchored on
`SortNode`, Structural pass, `sideEffectMode: 'aware'`), in the existing
`rule-scalar-agg-decorrelation.ts` alongside the Project / Aggregate / Filter
anchors. A correlated scalar-aggregate subquery in an ORDER BY key —
`order by (select count(*) from c where c.fk = o.k)` — becomes:

```
Project[ <one bare col ref per original Sort attribute, ids preserved> ]   -- capToAttributes
  Sort[ key = <guarded value read> ]        -- sort key reads the join's value column
    LeftJoin[ o.k = inner.k ]
      <original Sort source>                 -- outer, on the left
      Aggregate(groupBy=[inner.k], count(*))
        Filter(residual inner-only preds, inner)
```

The join lands **below** the Sort so the key can read the grouped value column;
the per-subquery rewrite (`decorrelateOne`, empty-input CASE guard, equi-pair
extraction, value-faithful outer remap) is shared verbatim with the other three
sites. Because a `SortNode` publishes its source's attributes verbatim, the
result is capped with the **same** bare pass-through Project used by the Filter
site (`capToAttributes`) so the Sort's output shape is byte-identical (no leaked
join columns) whether or not an enclosing Project exists.

## State on entry (this was a resumed run)

The prior run (timed out mid-investigation) had already committed the rule,
registration, module-header + `docs/optimizer-rules.md` prose, and the test
files — but left **2 failing plan-spec tests and 1 broken `.sqllogic` line**.
This run diagnosed and corrected those; **no rule/optimizer logic was changed**
(the rule was already correct). The `git rm`'d `dumpplan.mjs` was a prior-run
debug script.

## The core scope finding (reviewer should scrutinize)

The rewrite fires only when **the correlation column is an attribute of the
Sort's own source**. This is not incidental — it is where the ticket's design
assumption (`Sort(source)` where `source` carries the correlation column) meets
reality:

- `select o.* … order by (subq on o.k)` — identity projection, source is the
  base scan → **decorrelates**.
- `select o.id, o.k … order by (subq on o.k)` — o.k selected, so present in the
  Sort's source → **decorrelates**.
- `select o.id … order by (subq on o.k)` — o.k **projected away**; the Sort sits
  above a *stripping* Project whose output lacks o.k → `decorrelateOne` **bails**,
  subquery stays correlated. **Still correct**: at runtime the correlated o.k
  resolves from the still-live base-scan row context *below* the Project (Quereus
  resolves correlated refs by attribute id off a live context stack, not off the
  Sort's input row). It is merely not optimized.

The stripping-projection case is a genuine optimization gap (not a defect — it
bails to a correct plan). Threading the value column up through a stripping
Project needs real column-index care, so it is deferred to
`backlog/feat-decorrelate-order-by-subquery-nonselected-column`. The bail is
pinned by a plan-spec test and a `.sqllogic` case.

## Validation

- **`test/plan/scalar-agg-decorrelation.spec.ts`** (sort-site block, all green):
  ORDER BY subquery → grouped aggregate under a physical LEFT join (correlation
  column selected); `select *` bare-top-level-Sort shape invariance; non-equi
  correlation bail; **stripping-projection bail (new test)**; same subquery in
  both the SELECT list (Project site) and the ORDER BY (Sort site).
- **`test/vtab/correlated-scalar-agg-scan-count.spec.ts`**: the sort anchor scans
  the child table **once** across N outer rows (vs N re-scans with the rule
  disabled) — the actual N+1 elimination, not just result equality.
- **`test/logic/07.7-scalar-agg-decorrelation.sqllogic`** (sort section):
  basic asc + id tiebreak; DESC + LIMIT above the Sort; empty-group NULL ordering
  with NULLS FIRST/LAST; SELECT-list + ORDER BY same shape; multi-key partial
  (only one key correlated); stripping-projection bail (still correct); non-equi
  bail; derived-table shape invariance.
- Full `yarn test`: **7087 passing, 0 failing**, 13 pending. `yarn lint` clean.

**Testing emphasis for the reviewer** — the results-only `.sqllogic` cases pass
on the correlated path too, so trust the **plan-spec** and **scan-count** specs
as the proof the rule actually fires. Good places to push harder: multi-key
ORDER BY where two *different* correlated subqueries appear; ORDER BY subquery
whose empty value is non-NULL and non-count (e.g. `total`); interaction with
LIMIT/OFFSET stacked above the cap Project on larger data; and the same subquery
appearing three times (SELECT + WHERE + ORDER BY).

## Known gaps and honest notes

- **Stripping-projection bail** (correlation column not selected): correct but
  unoptimized. Follow-up: `backlog/feat-decorrelate-order-by-subquery-nonselected-column`.
  Documented at the rule site (`NOTE:` in `ruleScalarAggDecorrelationSort`), the
  module-header `SCOPE:` note, and `docs/optimizer-rules.md`.
- **ORDER BY over a GROUP BY aggregate query is blocked by a pre-existing bug**
  and therefore has **no decorrelation test**. An aggregate scalar subquery in
  that ORDER BY mis-resolves its inner aggregate to the outer aggregate's output
  alias and throws `Scalar subquery returned more than one row` — a build-phase
  planner scope-leak, reproducing uncorrelated and with all decorrelation
  disabled. Filed as **`fix/order-by-aggregate-subquery-scope-leak`**; the one
  `.sqllogic` line that exercised it (added by the prior run) was removed and
  replaced with a NOTE. Tracking files reconciled:
  `.pre-existing-error.md` (was pointing here) updated to its resolved
  disposition, and `.pre-existing-known.md` maps it to the fix slug. **Nothing
  was skipped/disabled/loosened** — the line tested a scenario the feature cannot
  reach while the baseline itself throws.
- **`capToAttributes` extra Project:** for an ORDER BY already under a SELECT
  Project the cap is a redundant pass-through (documented at the function). Its
  source carries more attributes than it outputs, so no trivial-project rule
  folds it — harmless one extra node; noted for anyone chasing plan-shape noise.
- **Physical selection:** the inserted LEFT join is picked up by hash/merge join
  selection (asserted); the win is the inner pipeline running once, same as the
  other sites.

## Review findings (tripwires index — parked, not queued as tickets)

- **Stripping-projection optimization gap** — parked as a `NOTE:` at the rule
  site + module-header `SCOPE:` note + `docs/optimizer-rules.md`; follow-up is
  `backlog/feat-decorrelate-order-by-subquery-nonselected-column`. Not a defect
  (bails to a correct plan).
- **Pre-existing aggregate-ORDER-BY scope-leak** — a real latent defect, not a
  tripwire; filed as `fix/order-by-aggregate-subquery-scope-leak` and recorded in
  `.pre-existing-known.md`. Reachable by users now (any grouped query ordering by
  an aggregate subquery throws), but orthogonal to this ticket.
- **Redundant cap Project** — documented at `capToAttributes`; only matters if it
  shows up in plan-shape noise or profiling (conditional).
