description: A query that ORs two overlapping ranges on an indexed column, such as "x between 1 and 3 or x between 2 and 4", returns every row in the overlap twice. Such a query must return each matching row once.
architecture: docs/module-authoring.md
files:
  - packages/quereus/src/vtab/memory/layer/scan-layer.ts          # multi-range loop in scanLayerResolved (~line 287)
  - packages/quereus/src/vtab/memory/module.ts                    # buildMonotonicAdvertisement comment "OR_RANGE concatenates disjoint ranges" (~line 748)
  - packages/quereus/src/planner/analysis/constraint-extractor.ts # tryCollapseToOrRange: mints OR_RANGE without checking disjointness
  - packages/quereus-isolation/src/isolated-table.ts              # buildMultiRangeWindowMatcher: overlay merge over a multi-range stream
  - docs/module-authoring.md                                      # OR_RANGE contract (~line 165 and ~line 818)
repro: verified
----
# OR of overlapping ranges returns overlapping rows twice

## Observed

On the memory backend, with an index on `x` (or with `x` as the primary key):

```sql
create table t (id integer primary key, x integer);
create index tx on t(x);
insert into t values (1,1),(2,2),(3,3),(4,4),(5,5);
select id from t where x between 1 and 3 or x between 2 and 4 order by id;
-- returns 1,2,2,3,3,4   expected 1,2,3,4
```

Every way of writing the query gives the same wrong result: `(x >= 1 and x <= 3) or (x >= 2 and x <= 4)`, the same query on `id`, and the placeholder forms bound to `[1, 3, 2, 4]`. The same query against a copy of the table with no index returns `1,2,3,4`. An OR of equalities (`x = ? or x = ?` bound to `[2, 2]`) returns the row once, because that shape collapses to `IN` instead. I ran this during review of `between-with-placeholder-bounds-offered-to-modules`. That ticket did not cause the bug, but it adds another way to reach it: before it, the BETWEEN form with placeholders was never pushed to the index.

## Cause

`tryCollapseToOrRange` in the constraint extractor turns an OR of same-column ranges into one `OR_RANGE` constraint. It does not check whether the ranges overlap, and when the bounds are placeholders it cannot. The memory module serves `OR_RANGE` by walking each range in turn and concatenating the results (`scanLayerResolved`, multi-range branch). A row inside two ranges is therefore yielded once for each range. The comment in `buildMonotonicAdvertisement` ("OR_RANGE concatenates disjoint ranges") states an assumption that nothing enforces.

## Expected behaviour

An `OR_RANGE` seek returns each matching row exactly once, whether its ranges overlap, nest, repeat, or are empty or reversed, and whether the bounds are literals, placeholders or outer-query columns.

- Overlap can only be decided after the bound values are known, so the guarantee belongs where the ranges are walked at run time, not in the planner. One way to do it: sort the ranges by lower bound under the index comparator and merge the overlapping ones before walking. That also gives index order, which the `NOTE:` above the loop in `scan-layer.ts` asks for.
- `docs/module-authoring.md` should state the contract for module authors: `OR_RANGE` ranges may overlap, and a module must not return a row twice.
- Check whether the isolation overlay (`buildMultiRangeWindowMatcher` and the merge it feeds) and the store module serve `OR_RANGE`. If they do, check that each behaves correctly over overlapping ranges. I checked only the memory backend.
- Pin the fix with one sqllogic case on overlapping literal ranges, with its result checked against the same query on a table that has no index.
