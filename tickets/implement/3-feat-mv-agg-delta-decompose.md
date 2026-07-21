description: Let an aggregate materialized view maintain a stored average (or any aggregate defined as a formula over simpler ones) arithmetically, by delta-maintaining its parts and recomputing the formula per group — but only when those parts are also stored columns of the same view.
prereq: feat-mv-agg-delta-arm
files: packages/quereus/src/core/database-materialized-views-plans.ts, packages/quereus/src/core/database-materialized-views-plan-builders.ts, packages/quereus/src/core/database-materialized-views-apply.ts, packages/quereus/test/incremental/maintenance-equivalence.spec.ts, docs/mv-maintenance.md
----
## Goal

Add the **decomposition-maintained** class to the aggregate delta arm from
`feat-mv-agg-delta-arm`: a stored aggregate column whose value is a scalar expression over
sibling partial aggregates (`algebra.decompose`) — `avg(x) ≡ sum(x)/count(x)`, and any UDAF
declaring `decompose` (geometric mean → `sum(log x)`/`count`). Such a column is maintainable
**only when every partial it names is also stored as a sibling column** of the same MV body and
each partial is itself delta-maintainable. Then: delta-maintain the partials arithmetically,
and re-evaluate `decompose.combine` per affected group at flush.

This is the general form of the historic avg special case. `avg` is nothing special here — it is
the first `decompose` client.

## Design

Extend the create-time descriptor + flush from `feat-mv-agg-delta-arm`.

**Create gate (`plan-builders.ts`).** For a stored aggregate column declaring `decompose`:
resolve each `decompose.partials[i]` (`{func, arg}`) to a **sibling stored aggregate column** of
the same body (same argument source column for `'same-arg'`; a `count(*)` column for `'star'`).
If every partial maps to a stored, delta-maintainable sibling column → the decomposed column is
maintainable: record it as a `DeltaAggregateColumn` of class `'decompose'` carrying the partial
backing-column indices and the `combine` closure. If any partial is missing or not
delta-maintainable → the decomposed column is **not** maintainable → the whole MV falls back to
residual (honest and visible: the user wrote a body without the partials).

The decomposed column contributes **no** independent delta accumulation — it is derived. Its
partials are ordinary group/tighten columns already delta-maintained. (avg's partials are
`sum(x)` and `count(x)`, both abelian-group; the integer-domain float gate from
`feat-mv-agg-delta-arm` applies to the `sum` partial exactly as for a standalone sum.)

**Flush (`apply.ts`).** After computing each partial column's finalized value (the existing
group/tighten RMW), evaluate each decompose column:
`row[decomposeCol] = decompose.combine([finalized(partial) for each partial])`. For avg this is
`countV === 0 || countV == null ? null : sumV / countV` — the empty-group / all-NULL case yields
NULL, matching native `avg`. Emptiness (delete) is still governed by the multiplicity column, so
a fully-emptied group is deleted before `combine` would divide by zero; a non-empty all-NULL
group finalizes count>0 and `combine` produces the correct value.

## TODO

- [ ] `plan-builders.ts`: resolve `decompose.partials` to sibling stored columns; admit the
      decompose column only when all partials are stored + delta-maintainable; tag as class
      `'decompose'` with partial backing-col indices + `combine`. Else MV → residual.
- [ ] `apply.ts`: at flush, after partial RMW, evaluate `combine` per group to fill the
      decompose column's stored value. No independent accumulation for decompose columns.
- [ ] `plans.ts`: extend `DeltaAggregateColumn` with the `'decompose'` variant (partial indices
      + combine).
- [ ] `maintenance-equivalence.spec.ts`: add
      `select k, count(*) as c, sum(a) as s, avg(a) as av from src group by k` — avg maintained
      via its stored sum+count partials, across mutations + rollback. Add a
      body WITHOUT the partials (`select k, avg(a) from src group by k`) and assert it stays on
      residual (equivalence still holds — just not delta). Add a `decompose` UDAF (geometric-mean
      style) with its partials stored.
- [ ] `docs/mv-maintenance.md`: document the decompose class and the "partials must be stored
      siblings" requirement; state avg is the first client, not a special case.
- [ ] `yarn build && yarn test && yarn lint` green.

## Edge cases & interactions

- **avg without stored partials.** `select k, avg(a) group by k` has no stored sum/count → not
  decomposable → residual. Must stay correct (the oracle covers it) — just not incremental.
- **Divide-by-zero / empty group.** `combine` must yield NULL for count 0 / NULL; a fully
  emptied group is deleted via the multiplicity witness before combine matters. Pin both: a group
  emptied to zero rows (deleted) and a group left with only NULL-`a` rows (count(*)>0, count(x)=0,
  avg = NULL).
- **Float gate on the sum partial.** avg over a REAL column: its `sum` partial fails the
  integer-domain gate → the whole MV falls to residual (avg over REAL is not delta-maintainable).
  Consistent with `feat-mv-agg-delta-arm`. Document.
- **count(*) vs count(x) partial for avg.** `decompose` names `count(same-arg)` = `count(x)` (the
  NULL-excluding count avg divides by). A body storing only `count(*)` (not `count(x)`) does not
  satisfy avg's decompose **unless** `x` is NOT NULL — mirror the read-side relaxation from
  `feat-mv-agg-rollup-retarget` (count(*) qualifies as the divisor when the argument is NOT NULL).
  Keep this rule identical on both sides.
- **Partial shared across decompose columns.** Two decompose columns sharing a partial (e.g. avg
  and a variance-style column both over the same sum) must both read the one stored partial — do
  not double-maintain the partial.
- **Decompose column is never a multiplicity witness.** It is derived; the `count(*)` requirement
  is satisfied by an actual stored `count(*)`, not by a decompose column.
