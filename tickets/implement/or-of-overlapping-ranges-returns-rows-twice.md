description: A query that ORs two ranges on an indexed column returns rows in the overlap twice, and inside a transaction it can show a row that was already deleted when the ranges are written high-to-low. The memory backend should merge the ranges and walk them in index order, so each matching row comes back once and in order.
architecture: docs/module-authoring.md
files:
  - packages/quereus/src/vtab/memory/layer/scan-layer.ts          # multi-range branch of scanLayerResolved (~line 286); orderSeekKeys (~line 37) is the multi-seek analogue; isDescBoundColumn/seekFromUpper (~lines 337 and 398)
  - packages/quereus/src/vtab/memory/layer/scan-plan.ts           # builds plan.ranges from idxStr rangeOps (~line 319); ScanPlanRange type
  - packages/quereus/src/vtab/memory/layer/plan-filter.ts         # ResolvedScanComparators.bound: the bound column's typed+collated comparator
  - packages/quereus/src/vtab/memory/module.ts                    # buildMonotonicAdvertisement comment "OR_RANGE concatenates disjoint ranges" (~line 748)
  - packages/quereus-isolation/src/isolated-table.ts              # mergedQuery: a primary-key multiRangeSeek goes through mergeStreams, which needs PK order
  - packages/quereus-isolation/src/merge-iterator.ts              # mergeStreams: position-based merge over sorted streams
  - packages/quereus-isolation/test/key-set-seek-merge.spec.ts    # pattern for an isolation-over-memory regression (instrumented memory module)
  - docs/module-authoring.md                                      # OR_RANGE contract (~line 165 PredicateConstraint.ranges, ~line 818 non-literal bounds)
  - packages/quereus/test/logic/100-predicate-normalization-edge-cases.sqllogic  # existing OR-of-ranges cases; candidate home for the new case
repro: verified
----
# OR of ranges: overlapping rows returned twice, and staged deletes undone under isolation

## Reproduction (ran it)

Memory backend, `create table t (id integer primary key, x integer); create index tx on t(x); insert into t values (1,1),(2,2),(3,3),(4,4),(5,5);`

| query | got | expected |
|---|---|---|
| `select id from t where x between 1 and 3 or x between 2 and 4 order by id` | 1,2,2,3,3,4 | 1,2,3,4 |
| `select id from t where id between 1 and 3 or id between 2 and 4 order by id` | 1,2,2,3,3,4 | 1,2,3,4 |
| `select id from t where id between 4 and 5 or id between 1 and 2` (no order by) | 4,5,1,2 | any order of 1,2,4,5 |

The same table wrapped in `IsolationModule({ underlying: new MemoryTableModule() })`, inside `begin; update t set x = 10 where id = 4; delete from t where id = 1;`:

| query | got | expected |
|---|---|---|
| `select id, x from t where id between 4 and 5 or id between 1 and 2 order by id` | (1,1),(2,2),(4,10),(5,5) | (2,2),(4,10),(5,5) |
| `select id, x from t where id between 1 and 4 or id between 3 and 5 order by id` | (2,2),(3,3),(3,3),(4,10),(4,10),(5,5) | (2,2),(3,3),(4,10),(5,5) |

The first isolation row shows that row 1, deleted in the open transaction, is visible again. That is worse than a duplicate.

The store module does not serve `OR_RANGE`: nothing in `packages/quereus-store/src` advertises it. So isolation over store cannot reach this, and `yarn test:store` will not exercise it.

## Cause

One site causes both: the multi-range branch of `scanLayerResolved` in `scan-layer.ts`. It walks each range of `plan.ranges` in turn, in SQL-text order, and concatenates the results.

- A row inside two ranges is yielded once per range. The planner (`tryCollapseToOrRange` in `constraint-extractor.ts`) cannot rule out overlap: placeholder and correlated bounds are only known at run time. So the guarantee has to sit in the run-time walk.
- The stream is not in index order. For a primary-key multi-range seek, `IsolatedTable.mergedQuery` uses `mergeStreams`, a position-based merge that pairs each staged overlay entry with the stored row it shadows. That pairing requires the underlying rows in primary-key order. Out of order, the tombstone for row 1 is used up against row 4's position before row 1 arrives, so row 1 comes through. The same hazard was fixed for multi-seek `IN` lists by `orderSeekKeys` (see the header of `key-set-seek-merge.spec.ts`). The `NOTE:` above the loop says the SQL-text order is harmless, which is wrong for this reason.

The secondary-index merge (`mergedSecondaryIndexQuery`) drops shadowed rows by primary key, so it gets the set right even when the order is wrong. It still repeats rows that the memory module yields twice. The overlay-side window predicate (`buildMultiRangeWindowMatcher`) is a `ranges.some(...)` test and never duplicates.

## Fix: normalize the ranges before walking

In the multi-range branch, turn `plan.ranges` into a sorted list of disjoint ranges, then walk that list in the physical direction of the walk. Each sub-walk stays an ordinary single-range `scanLayerResolved` call as today. All comparisons use `comparators.bound`, the bound column's comparator. It already includes the column's type ordering and the collation the plan was accepted under. The planner offers `OR_RANGE` only when that collation equals the index column's, so this order is the index's order.

Normalization, in order:

- **Drop ranges that match nothing.** A range with a NULL bound value matches no row under three-valued logic. It must not take part in a merge, because merging it could widen another range. Also drop an empty or reversed range: lower > upper, or lower = upper when either bound is strict.
- **Sort by lower bound.** A missing lower bound (unbounded) sorts first. On equal values, an inclusive (`GE`) bound sorts before a strict (`GT`) one.
- **Coalesce.** Merge the next range into the current one when the current has no upper bound, or the next has no lower bound, or `cmp(next.lower, current.upper) < 0`, or the two values are equal and at least one of the two bounds is inclusive. `[1,3] ∪ (3,5]` and `[1,3) ∪ [3,5]` become one range. `[1,3) ∪ (3,5]` stays two ranges, because merging it would admit 3. The merged upper bound is the larger of the two. A missing upper wins. On equal values, the inclusive bound wins.
- **Direction.** The merged list is in ascending value order. Reverse it when the walk visits the bound column from high to low, which is exactly when `seekFromUpper` holds (`!plan.descending === isDescBoundColumn`). `isDescBoundColumn` comes from `primaryKeyDefinition[0].desc` on the primary path and from `indexDef.columns[0].desc` on a secondary index. `OR_RANGE` is only matched on the leading index column (`findOrRangeMatch(indexCols[0], …)` in `module.ts`), so `boundPosition` is 0 and there is no equality prefix. Factor the direction rule out of the two inline copies, or compute it once for the leading column. Don't add a third copy.

After this the ranges are disjoint, so no row can be yielded twice. A primary-key dedup set like the multi-seek branch's is not needed. Don't add one. It would hide a merge bug instead of exposing it.

Keep the normalization as its own small function next to `orderSeekKeys`, for example `normalizeRanges(ranges, compare, highToLow)`. `scanLayerResolved` then just loops over the result.

### Alternatives rejected

- Dedup yielded rows by primary key, as multi-seek does. That fixes the duplicates but not the order, so the isolation case that brings back a deleted row stays broken.
- Reject overlapping ranges in `tryCollapseToOrRange`. That only works for literal bounds. Placeholder and correlated bounds are unknown at plan time.

## Related comments and docs

- `scan-layer.ts`: replace the `NOTE:` above the multi-range loop. Say that ranges are merged into disjoint ranges and walked in index order, because isolation's primary-key merge depends on that order.
- `module.ts` `buildMonotonicAdvertisement`: the "OR_RANGE concatenates disjoint ranges" comment becomes false. Reword it to say the memory module walks the merged ranges in index order but still does not advertise `monotonicOn` for `OR_RANGE`. Turning that advertisement on is out of scope: it changes plans and needs its own tests. Add a `NOTE:` tripwire for it at that site.
- `docs/module-authoring.md`: state the contract near `ranges?: RangeSpec[]` (~line 165) or the `OR_RANGE` paragraph (~line 818). The ranges of an `OR_RANGE` may overlap, nest, repeat, be empty or be reversed, and with non-literal bounds this is only known at query time. A module must return each matching row exactly once. A module wrapped by the isolation layer that serves `OR_RANGE` on its primary key must also return rows in primary-key order, because the overlay merge pairs rows by position.

## Tests

Two, each the reproduction of one observed failure:

- **sqllogic (memory):** overlapping literal ranges on a secondary index and on the primary key, with `order by id`. Check the result against the same query on an unindexed copy of the table, in the same file. Add a nested case and a touching case (`x between 1 and 3 or x between 3 and 5`) to the same block only if they are cheap one-liners. `100-predicate-normalization-edge-cases.sqllogic` already has OR-of-range cases and is a reasonable home.
- **isolation over memory:** the deleted row that came back. Ranges in high-to-low SQL order on the primary key, a staged delete inside one range, and the assertion that the deleted row is absent. Follow `key-set-seek-merge.spec.ts`: an instrumented memory module asserts the read really was a `multiRangeSeek` (idxStr `plan=6`), so the test cannot pass vacuously on a full scan. Put it in that file, or next to it with a matching name.

`debt-index-seek-matches-unindexed-query-property` (backlog) already proposes the general property test that would cover range ORs. Don't build it here.

## TODO

- Add a range-normalization helper (drop null/empty/reversed ranges, sort, coalesce, orient) next to `orderSeekKeys` in `scan-layer.ts`, and use it in the multi-range branch of `scanLayerResolved`. Compute the leading-column walk direction once, without duplicating the `seekFromUpper` logic a third time.
- Replace the multi-range `NOTE:` in `scan-layer.ts`. Reword the `buildMonotonicAdvertisement` comment in `module.ts` and add a tripwire `NOTE:` about the monotonic advertisement.
- Document the `OR_RANGE` overlap and ordering contract in `docs/module-authoring.md`.
- Add the sqllogic regression (overlapping ranges, indexed vs unindexed copy).
- Add the isolation-over-memory regression (ranges in reverse order, staged delete, multiRangeSeek asserted).
- Run `yarn workspace @quereus/quereus test`, the isolation package tests and `yarn workspace @quereus/quereus lint`.
