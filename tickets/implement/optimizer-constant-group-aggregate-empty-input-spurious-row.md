description: Fix `ruleGroupByFdSimplification` so it never drops *every* GROUP BY column. When all group columns are equality-pinned to constants (`where a=0 and k=6`) the FD cover goes empty, the rule rebuilds the aggregate with an empty GROUP BY (a scalar aggregate), and an empty input then emits one spurious all-NULL `count=0` row instead of zero rows. Add a sqllogic regression.
files: packages/quereus/src/planner/rules/aggregate/rule-groupby-fd-simplification.ts, packages/quereus/src/planner/util/fd-utils.ts, packages/quereus/test/logic/
----

# Constant-pinned multi-column `group by` collapses to a scalar aggregate (spurious row over empty input)

## Root cause (confirmed by reading the rule source)

The culprit is `ruleGroupByFdSimplification` in
`packages/quereus/src/planner/rules/aggregate/rule-groupby-fd-simplification.ts`.
(Note: there is **no** `constant-group.ts` / `aggregate-streaming.ts` — an earlier
investigation chased phantom filenames; the only two aggregate rule files are
`rule-groupby-fd-simplification.ts` and `rule-aggregate-streaming.ts`.)

The rule drops GROUP BY columns that are functionally determined by the *other* GROUP BY
columns, re-emitting each dropped column as a `MIN(col)` "picker" aggregate to preserve
output attribute IDs. The trace through the empty-match repro:

1. `if (node.groupBy.length <= 1) return null;` (line ~48) — **this is exactly why the
   single-column case is correct**: the rule never fires for a one-column GROUP BY.
2. With `where a = 0 and k = 6`, both `a` and `k` are *constant* within the filtered
   relation. FD/EC propagation (`propagateAggregateFds`, `expandEcsToFds`) represents each
   constant column as an FD with an **empty determinant** (`{} → a`, `{} → k`) in
   aggregate-output space.
3. `minimalCover(candidateSet, combinedFds)` (line ~102) can then satisfy every candidate
   from `{}`, so it returns an **empty cover**. The guard `if (cover.size === candidateSet.size) return null;`
   (line ~103) does *not* catch this (0 ≠ 2).
4. Every candidate is moved to `dropped`; since the GROUP BY is *all* bare-column
   candidates, `keptGroupBy` ends up `[]` (lines ~114-125).
5. The rule returns `new AggregateNode(scope, source, keptGroupBy /* [] */, [MIN(a), MIN(k), count(*), sum(b)], …)`
   — an **empty-GROUP-BY (scalar) aggregate**. A scalar aggregate emits exactly one row
   over an empty input (`MIN(a)=null, MIN(k)=null, count=0, sum=null`), producing the
   reported `[{a:null, k:null, c:0, s:null}]`. A grouped query must emit **zero** rows.

The rule's own soundness comment ("a mapped source key `K` makes each group a single
source row…") justifies dropping *functionally-determined* columns, but it does **not**
justify dropping *all* grouping columns: removing the last group key changes the query's
cardinality contract (zero-rows-over-empty-input → one-row), which is never sound. In this
repro the drops are driven purely by constant (`{} →`) FDs, with no surviving key at all.

## Fix

Constant-/FD-driven GROUP BY simplification must preserve the zero-rows-over-empty-input
contract: a query that *had* a GROUP BY must keep **at least one** grouping column. It may
drop a strict subset (the surviving key still gates row production and the dropped columns
are constant within each group, so `MIN(col)` faithfully recovers them), but it must never
empty the GROUP BY.

Minimal, clearly-correct guard — bail out (or retain one column) whenever the rewrite would
leave no grouping columns. Add it right after `keptGroupBy` is built (around line ~125),
before synthesizing pickers:

```ts
// Never collapse a grouped aggregate to a scalar (empty-GROUP-BY) aggregate:
// that would emit one row over an empty input instead of zero. Keep at least
// one grouping column.
if (keptGroupBy.length === 0) return null;
```

Returning `null` is the simplest sound choice. (Optionally, instead of bailing entirely you
could *retain one* dropped candidate as a real group key and still drop the rest — a
strictly better optimization — but the simple bail is correct and low-risk; decide based on
whether the partial-drop path has measured value and note the decision.)

Consider whether the earlier guard at line ~103 should also be tightened, but the
`keptGroupBy.length === 0` check is the precise, sufficient fix and is independent of how
`minimalCover` behaves.

## Regression test

Add a sqllogic file under `packages/quereus/test/logic/` (copy the directive syntax from an
existing aggregate file such as `25.3-aggregate-isnull-empty.sqllogic` or
`92-hash-aggregate-edge-cases.sqllogic`). Seed and cases:

```sql
create table t (id integer primary key, a integer, b integer, k integer);
insert into t values (2, 3, 4, 2), (3, 7, 1, 9);

-- multi-column, constant-pinned, EMPTY match  → [] (regression for this bug)
select a, k, count(*) as c, sum(b) as s from t where a = 0 and k = 6 group by a, k;

-- multi-column, constant-pinned, NON-EMPTY match → exactly one group row {3,9,1,7}
select a, k, count(*) as c, sum(b) as s from t where a = 3 and k = 9 group by a, k;

-- single-column control, empty match → [] (must stay correct)
select k, count(*) as c, sum(a) as s from t where k = 6 group by k;
```

Confirm the non-empty case still benefits from / is unaffected by FD simplification (right
result, no dropped-column corruption).

## Mitigation to leave in place

`residualRowMatchesKey` in `database-materialized-views.ts` (the MV residual-recompute arm)
currently masks this for that one consumer; it is a sound invariant regardless. **Do not
remove it** — once this fix lands it simply becomes a harmless no-op.

## Validation

- `yarn build` (type-check) then `yarn test` (quereus logic suite) — green, including the
  new regression file. Stream output: `yarn test 2>&1 | tee /tmp/test.log; tail -n 80 /tmp/test.log`.
- Sanity-check that existing FD-simplification coverage (queries that legitimately drop a
  *subset* of GROUP BY columns) still passes — the guard only triggers when *all* would be
  dropped.

## TODO

- [ ] Add the `if (keptGroupBy.length === 0) return null;` guard in `ruleGroupByFdSimplification` (after `keptGroupBy` is built, before picker synthesis).
- [ ] (Optional) Evaluate retaining one dropped candidate instead of bailing; note the decision.
- [ ] Add the sqllogic regression (empty multi-col → `[]`; non-empty multi-col → one row; single-col control → `[]`).
- [ ] `yarn build` + `yarn test` green (stream with `tee`).
- [ ] Leave `residualRowMatchesKey` in `database-materialized-views.ts` untouched.
