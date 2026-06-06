description: |
  Now that the streaming-aggregate filter-drop bug is fixed
  (prereq: streaming-aggregate-stale-group-context-shadows-child-filter), relax the
  `rollup-residual` forgo in the materialized-view query-rewrite matcher. The matcher
  currently refuses any rollup rewrite that would need a residual filter over the MV
  backing, because that produced exactly the now-fixed bug shape (re-aggregate over a
  composite-PK backing with a WHERE on a non-grouped key). Remove the forgo, let the
  rule build the residual Filter on the backing scan, and extend the MV equivalence
  harness with rollup-plus-residual shapes so the soundness backstop covers them.
prereq: streaming-aggregate-stale-group-context-shadows-child-filter
files:
  - packages/quereus/src/planner/analysis/query-rewrite-matcher.ts   # the `fail('rollup-residual')` guard (~line 688) + RewriteFailureReason union
  - packages/quereus/test/query-rewrite-aggregate.spec.ts            # the 'rollup-residual' unit test (~line 257) must flip to expect a match
  - packages/quereus/test/query-rewrite-equivalence.spec.ts          # AGG_QUERIES corpus (~line 147) — add rollup+residual shapes
  - packages/quereus/src/planner/rules/retrieve/                     # the rule that consumes RewriteMatch.residualConjuncts to build the residual Filter (confirm path during impl)

# Relax the MV rollup-residual forgo

## Background

`matchAggregateFragmentToMv` (`query-rewrite-matcher.ts`) contains:

```ts
// PRE-EXISTING ENGINE BUG WORKAROUND. ...
if (!exact && residualConjuncts.length > 0) return fail('rollup-residual');
```

This deliberately forgoes a rollup rewrite (re-aggregating the MV backing to a
coarser group key) whenever the query imposes a residual WHERE the MV's body did not
already apply — because re-aggregating over the backing (whose PK is the often-
composite MV group key) with a residual filter on a non-grouped key reproduced the
streaming-aggregate filter-drop bug. With that base bug fixed, the rewrite is sound
and the forgo can be removed; the matcher already computes `residualConjuncts` and
the rule already knows how to build a residual `Filter` on the backing scan (this is
the same machinery exact-key and scan rewrites use).

## What to do

- **Remove the `fail('rollup-residual')` guard** so a rollup with
  `residualConjuncts.length > 0` proceeds to assemble its `RewriteMatch`/`AggregateRollup`
  the same way the no-residual rollup does. The rule that consumes the match must wrap
  the backing scan in a Filter built from `residualConjuncts` (re-bound onto the
  backing columns via `backingColOfBaseCol` / `backingColOfSourceAttrId`) BEFORE the
  re-aggregate — confirm the rule already does this for the residual path and, if it
  only did so for exact-key, extend it to the rollup path.
- **Decide the fate of the `'rollup-residual'` `RewriteFailureReason`.** Prefer to
  delete the union member and its comment now that nothing emits it (keeps the reason
  set honest). If a same-named diagnostic is still wanted for a genuinely
  unsupported residual shape, repurpose it explicitly — do not leave it dangling.
- **Flip the unit test.** `query-rewrite-aggregate.spec.ts` has
  `it('rollup-residual: a rollup needing a residual filter is forgone ...')` asserting
  `res.match` is undefined and `reason === 'rollup-residual'`. After the change that
  query (`select d, sum(amt) from sales where r = 20 group by d` against the `byregion`
  MV grouped by `(d,r)`) should now MATCH. Rewrite the test to assert a successful
  match with the residual `r = 20` captured in `residualConjuncts` (and remove the
  reason assertion). Re-check the neighbouring `group-key-pinned` test is unaffected.
- **Extend the equivalence harness.** In `query-rewrite-equivalence.spec.ts`, the
  `AGG_QUERIES` corpus (MV `amv_kj` grouped by `(k, j)` over `t(k, j, x, …)`) drives
  the `rewrite-on == rewrite-off` property. Add rollup-plus-residual shapes, e.g.:
  - `select k, sum(x) from t where j = 1 group by k`           (residual on non-grouped MV key)
  - `select k, count(*), count(x) from t where j >= 0 group by k`  (range residual; count recombine)
  - `select k, min(x), max(x), avg(x) from t where j = 0 group by k` (min/max/avg recombine under residual)
  These must return identical multisets with the rewrite on vs off across the random
  data (including the NULL/empty cases the corpus already generates).

## Edge cases & interactions

- **Residual on a grouped-by query key vs a dropped MV key.** Only the latter is a
  true rollup-residual; the former is `group-key-pinned` territory — make sure the
  relaxation does not accidentally swallow the pinned-key forgo (that guard runs
  earlier and stays).
- **Residual referencing a column the MV backing does not store.** Still must fail
  `missing-column`, not silently produce a wrong rewrite — keep that check ahead of
  the (now-removed) forgo.
- **NULL / empty-group semantics through the residual.** The residual Filter drops
  rows before re-aggregation; `sum`/`count(x)` must ignore NULLs identically to the
  base recompute (the harness's NULL rows cover this — assert, don't assume).
- **count(\*) vs count(col) recombine under a residual** — the residual changes which
  backing rows survive, so the per-backing-group partials being summed differ; verify
  the recombine recipe composes with the residual.
- **avg recombine** (sum/count pair) under a residual — most fragile; include it.
- **Cost gate.** A relaxed match may still be declined by `cost-declined`; the
  equivalence harness must pass regardless of which side the gate picks (it already
  toggles the rule on/off, so this is covered — just confirm no assertion presumes a
  rewrite actually fired).

## TODO

- [ ] Remove `fail('rollup-residual')`; ensure the rule builds the residual Filter on
      the backing scan for the rollup path (extend if it was exact-key-only).
- [ ] Delete (or explicitly repurpose) the `'rollup-residual'` `RewriteFailureReason`
      and its comment.
- [ ] Flip the `rollup-residual` unit test in `query-rewrite-aggregate.spec.ts` to
      assert a successful match with `residualConjuncts` populated.
- [ ] Add rollup-plus-residual shapes to `AGG_QUERIES` in
      `query-rewrite-equivalence.spec.ts`.
- [ ] `yarn workspace @quereus/quereus test` green; `yarn workspace @quereus/quereus run lint`.
