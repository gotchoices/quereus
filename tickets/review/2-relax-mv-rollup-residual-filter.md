description: |
  Relaxed the `rollup-residual` forgo in the materialized-view query-rewrite matcher.
  The matcher used to refuse any aggregate-rollup rewrite that needed a residual WHERE
  over the MV backing, because that shape (re-aggregate a composite-PK backing under a
  WHERE on a non-grouped PK column) tripped the now-fixed streaming-aggregate
  filter-drop bug. The forgo is removed; a rollup-with-residual now matches, the rule
  builds the residual Filter on the backing scan before the re-aggregate, and the
  equivalence harness covers the new shapes. Build + full test suite + lint all green.
prereq: streaming-aggregate-stale-group-context-shadows-child-filter
files:
  - packages/quereus/src/planner/analysis/query-rewrite-matcher.ts          # removed fail('rollup-residual') guard + union member
  - packages/quereus/src/planner/rules/cache/rule-materialized-view-rewrite.ts # CONFIRMED unchanged — already builds the residual Filter for the rollup path
  - packages/quereus/test/query-rewrite-aggregate.spec.ts                   # flipped the rollup-residual unit test to a positive match
  - packages/quereus/test/query-rewrite-equivalence.spec.ts                 # added 3 rollup+residual shapes to AGG_QUERIES + 1 to AGG_MUST_REWRITE
  - packages/quereus/test/plan/materialized-view-rewrite-plan.spec.ts       # flipped the rollup-residual golden-plan test (found during full run)
  - docs/optimizer.md, docs/materialized-views.md                          # forgo-guard count + harness description updated

# Review: Relax the MV rollup-residual forgo

## What changed (and why it is sound)

The single load-bearing edit is in `query-rewrite-matcher.ts`: the line

```ts
if (!exact && residualConjuncts.length > 0) return fail('rollup-residual');
```

(plus its big "PRE-EXISTING ENGINE BUG WORKAROUND" comment and the `'rollup-residual'`
`RewriteFailureReason` union member) is **deleted**. A rollup that needs a residual
now flows to the normal `RewriteMatch`/`AggregateRollup` assembly, identical to the
no-residual rollup.

**Soundness argument** (please scrutinize):
- The residual-coverage check **immediately above** the removed guard
  (`for (const clause of residualClauses) … if (!backingColOfBaseCol.has(col)) return fail('missing-column')`)
  is unchanged. For the aggregate arm, `backingColOfBaseCol` is seeded **only** from
  `stored.groupBackingOfBaseCol` — i.e. only the MV's stored group-key columns. So a
  residual conjunct can reference **only MV group-key columns**; anything else still
  fails `missing-column` (verified by the existing `missing-column` unit test, which
  stayed green).
- A predicate over group-key columns partitions the backing into **whole MV groups**:
  each `(k, j)` backing row either wholly satisfies the residual or is wholly dropped.
  Filtering whole groups *before* the rollup re-aggregate is therefore identical to
  filtering the equivalent base rows *before* the base aggregate — the recombine
  (`sum→sum`, `count→coalesce(sum,0)`, `min/max`, `avg→sum(sum)/sum(count)`) composes
  with the residual because every surviving partial is a complete group's partial.
- The only reason the forgo existed was the base streaming-aggregate filter-drop bug
  (prereq `streaming-aggregate-stale-group-context-shadows-child-filter`, now in
  `complete/`). With that fixed, `group by k` re-aggregating a composite-PK backing
  under `where j = const` no longer mis-drops the WHERE.

**The rule needed no change.** `buildRollupReplacement` already calls the shared
`buildBackingSource`, which wraps the backing `Retrieve` in a `FilterNode` built from
`match.residualConjuncts` (re-bound via `remapToBacking` → `backingColOfBaseCol`)
*before* constructing the re-aggregate `AggregateNode`. So the residual Filter on the
backing scan was already wired for the rollup path; only the matcher gate blocked it.
**Confirm this reading** — `rule-materialized-view-rewrite.ts:583-630` (`buildRollupReplacement`)
+ `:475-503` (`buildBackingSource`).

## Use cases / validation performed

- **Unit (`query-rewrite-aggregate.spec.ts`)** — the `rollup-residual` test was flipped
  from "forgone, reason === 'rollup-residual'" to "matches, `rollup.exact === false`,
  `residualConjuncts` length 1, recipe kind `sum`" for
  `select d, sum(amt) from sales where r = 20 group by d` against the `(d,r)` MV.
  Neighbouring `group-key-pinned` test (a ≥2-key query pinning a group col) confirmed
  unaffected — that guard runs *earlier* (line ~674) and stays.
- **Equivalence (`query-rewrite-equivalence.spec.ts`)** — added to `AGG_QUERIES` (MV
  `amv_kj` grouped by `(k,j)` over `t(k,j,x)`, x nullable, row count from 0):
  - `select k, sum(x) from t where j = 1 group by k`              (equality residual on dropped key)
  - `select k, count(*), count(x) from t where j >= 0 group by k` (range residual; count recombine)
  - `select k, min(x), max(x), avg(x) from t where j = 0 group by k` (min/max/avg under residual)
  Property: `rewrite-on == rewrite-off` as multisets across 40 random-data runs
  (including NULL/empty groups). Added `select k, sum(x) from t where j = 1 group by k`
  to `AGG_MUST_REWRITE` so the harness proves this shape **actually rewrites** (not a
  vacuous base==base compare).
- **Golden plan (`test/plan/materialized-view-rewrite-plan.spec.ts`)** — flipped the
  "rollup with a residual filter is forgone" test to assert the plan now contains
  `_mv_byregion`, drops the base `"main.regsales"`, and carries a
  `StreamAggregate|HashAggregate` re-aggregate node.
- **Full suite**: `yarn workspace @quereus/quereus test` → **4926 passing, 9 pending,
  0 failing**. `typecheck` (tsc --noEmit) clean. `lint` (eslint) clean.

## Where the reviewer should push hardest

- **Is the "residual references only group-key columns" invariant truly airtight?**
  The whole soundness rests on it. It is enforced by the pre-existing `missing-column`
  check seeded from `stored.groupBackingOfBaseCol`. Confirm a grouped MV can never
  store a *bare non-group* column that a residual could then filter (the completed
  ticket `3.1-mv-query-rewrite-aggregate-rollup` argued this is unreachable because
  Quereus rejects a grouped select picking a bare non-group/non-FD column at create
  time — worth re-verifying that claim still holds, since it is now load-bearing for
  correctness, not just for a speedup).
- **count(\*) vs count(col) under a residual** — the residual changes which backing
  rows survive; verify the per-group `cnt` partials being summed are still whole-group
  partials (the harness's `count(*), count(x)` under `j >= 0` covers this empirically,
  but eyeball the recombine).
- **avg under residual** — most fragile (sum/count pair). Covered by `min/max/avg under
  j = 0`, but confirm NULL-x and empty-survivor cases (avg over zero surviving rows ⇒
  NULL) — the harness starts at 0 rows and x is nullable, so these arise.
- **fast-check is sampling, not exhaustive.** 40 runs over small domains (k∈[-1,2],
  j∈[0,2], x∈[-3,6]∪NULL, ≤8 rows). High coverage of the boundaries but not a proof.
- **Cost gate.** The equivalence property does not presume a rewrite fires (compares
  on vs off either way), so a cost-gate decline cannot cause a false pass — but it
  *could* make a query silently never exercise the new path. The single
  `AGG_MUST_REWRITE` addition guards against that for `where j = 1`; other residual
  shapes rely on the property test alone.

## Notes

- Cleaned up one pre-existing unused-param lint (`gc` → `_gc`) adjacent to the edit in
  `query-rewrite-matcher.ts` (exact-key block) — cosmetic, in line with AGENTS.md.
- Docs updated: `docs/optimizer.md` and `docs/materialized-views.md` both went from
  "Two forgo guards" to one (`group-key-pinned`), with a paragraph explaining the
  rollup-with-residual is now admitted and why; the equivalence-harness description now
  lists the rollup+residual shapes.
