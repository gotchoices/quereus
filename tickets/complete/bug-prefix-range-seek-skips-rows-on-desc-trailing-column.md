description: On the in-memory backend, a query that filters on the first column of a compound index and asks for values greater than some number on a following column declared descending used to lose rows. It now returns every matching row.
architecture: docs/memory-table.md
files:
  - packages/quereus/src/vtab/memory/layer/scan-layer.ts
  - packages/quereus/test/logic/05.1.1-secondary-index-range-scan.sqllogic
  - packages/quereus/test/logic/05.1-composite-pk-range-scan.sqllogic
  - packages/quereus/test/vtab/scan-layer-descending.spec.ts
  - docs/memory-table.md
repro: verified
----

A prefix-range scan is a query with equality on the leading columns of a compound key and a range on the next column, such as `k = 'a' and r > 1` over `(k, r desc)`. On the memory backend, when that next column was `desc`, the scan started at the lower bound. Larger values sort first in a `desc` column, so every matching row above the bound sat before the start point and was skipped. The store backend already handled this and was not affected.

## What changed

All code changes are in `scan-layer.ts`, and they apply to both the primary key and secondary index branches.

- **Direction:** `seekFromUpper` now reads the direction of the column the bound applies to, at position `plan.equalityPrefix?.length ?? 0`, instead of column 0.
- **Start key:** the prefix start key appends the bound chosen by `seekFromUpper`, instead of always the lower bound. `seekStartKey` now builds the start key for both branches.
- **Stopping:** a prefix walk also stops when the bound column passes the bound the walk ends at, instead of reading to the end of the group. `pastTerminatingBound` compares only that bound, because the bound the walk starts from can reject its first row with matches still ahead. `walkIsExhausted` decides whether a rejected row ends the walk, for both branches.

`docs/memory-table.md` gained a sentence on the prefix-range bullet. Sqllogic cases were added to `05.1-composite-pk-range-scan.sqllogic` and `05.1.1-secondary-index-range-scan.sqllogic`, and they also run against the store.

## Review findings

**Validation, run after the review's edits**

- `yarn workspace @quereus/quereus lint`: clean.
- `yarn workspace @quereus/quereus test`: 10985 passing, 26 pending.
- `yarn workspace @quereus/quereus test:store`: 10978 passing, 33 pending.
- `@quereus/isolation`: 449 passing. `@quereus/store`: 1986 passing. `@quereus/sync`: 852 passing. The other workspace packages were not re-run after the review's edits; the implement stage reported them passing.

**Fixed in this pass**

- **Duplicated start-key logic:** both branches carried the same start-key block, and this fix had to edit both copies identically. It is now one helper, `seekStartKey`, which also removes casts that were not needed because `BTreeKeyForPrimary` and `BTreeKeyForIndex` are the same type. The one difference is an empty prefix with no bound, which now gets no start key instead of `[]`. The plan builder never produces that shape, because a prefix plan always has at least one equality column.
- **Stale test comment:** the comment above `idx_d` in `05.1.1-secondary-index-range-scan.sqllogic` said the primary key branch lacked DESC handling and was "tracked separately". The implement stage reworded that comment but kept the false claim. It is rewritten.

**Filed**

- `debt-index-seek-matches-unindexed-query-property` (backlog): nothing in the suite compares an indexed query with its unindexed equivalent. `property-planner.spec.ts` and `fuzz.spec.ts` never create an index, which is why this bug went unnoticed. A general test would cover the whole class of index bugs that drop rows, so this review filed that test rather than another point fix.

**Checked with throwaway specs, not committed; no defects found**

- **Bound values and column types:** 1,848 queries against an unindexed copy over 9 key shapes showed no differences. The shapes covered integer, real, `any`, text, date and timespan range columns, and NOCASE on the prefix and on both columns. Bounds included values of the wrong type (`'x'` against an integer column), fractional bounds on integers, and runtime NULL. All 9 shapes used the index according to `query_plan`.
- **Writes through the seek:** 8 `update` and `delete` statements, including ones that move a row ahead of the walk (`set r = r - 1`), ran inside and outside a transaction. Final table contents and a follow-up seek matched the unindexed copy.
- **Other query forms:** correlated bounds in joins and a scalar subquery, a subquery bound, `limit`, `order by r` in both directions, repeated bounds (`r > 3 and r > 1`, in both written orders), `in` combined with a range, and `or` of two ranges. All matched the unindexed copy.
- **NULL comparisons in `pastTerminatingBound`:** the docblock's claim holds, because `createTypedComparator` ranks NULL lowest before any type-specific compare. A NULL bound also ends safely, since `planAppliesToKey` rejects every row for it.
- **Seek past the end of the tree:** `safeIterate` falls back to the last row when a seek lands past the end. That row is rejected by the plan and cannot end the walk early or return a wrong row.

**Ticket's known gaps, re-examined**

- **Early stopping has no test:** still true, and no test was added. It only saves work, so a results test cannot pin it. Three queries over a 60,000-row group (`r > 59990` and `r < 10` on a secondary index, `r > 59990` on a primary key) each took under 1 ms per run, returning 9 or 10 rows. That is consistent with stopping early, but I did not time the same queries with the stop removed.
- **Seek use per shape:** the 9 shapes above are confirmed from `query_plan` (the plan detail names the index), and the 3 timing queries show `INDEX RANGE`. The other shapes in the implementer's 12 were not re-checked.
- **Transaction case not run on unfixed code:** not run in this review either. From the code, the old lower-bound start would have landed at `r = 2`, past the rows at `r = 4` and `r = 3`, so it would have returned no rows.
- **Reverse walks:** still broken for a prefix plan with no bound on its start side, and still unreachable: `ordCons` is never set, as `scan-layer-descending.spec.ts` records. Already tracked in `feat-reverse-index-walk-for-desc-ordering`, and its description still applies.

**Tests**

- **Cut:** none. The added cases each pin a different bound operator, key shape or walk boundary, and the implement stage had already removed repeats.
- **Added:** none. The defects fixed here were a refactor and a comment, and neither needs a test.

**Empty categories**

- **Tripwires:** no new ones. The existing `NOTE:` about the untested single-column secondary-index prefix moved to `seekStartKey` with the code it describes.
- **Accepted tradeoffs:** none apply. The `NOTE:` at the `isComposite` definition (`> 1` versus `!== 1`) concerns a shape this change does not reach.
- **Resource cleanup:** nothing to review, since the change holds no resources beyond the existing iterator.
- **Performance:** `walkIsExhausted` allocates only for rows the plan rejects, and early stopping now limits how many of those a prefix walk visits. Not profiled. `performance-sentinels.spec.ts` passes as part of the main test run.
- **Docs:** `docs/memory-table.md` is accurate after the change, and the review's edits did not change any documented behaviour. `scan-plan.ts` and `plan-filter.ts` describe the bound column correctly and needed no change.
