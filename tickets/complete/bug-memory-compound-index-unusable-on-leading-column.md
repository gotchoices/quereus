description: On the in-memory backend, filtering on the first column of a multi-column index or primary key now reads only the matching rows instead of the whole table. The work also stops the engine dropping a sort it still needed when text comparison rules differ between a query, a column and an index, and stops a number compared with a boolean key column from raising an error.
architecture: docs/memory-table.md
files:
  - packages/quereus/src/vtab/memory/module.ts
  - packages/quereus/src/vtab/memory/layer/scan-plan.ts
  - packages/quereus/src/vtab/memory/layer/scan-layer.ts
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts
  - packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts
  - packages/quereus/src/planner/nodes/table-access-nodes.ts
  - packages/quereus/src/types/builtin-types.ts
  - packages/quereus/test/plan/index-selection.spec.ts
  - packages/quereus/test/type-system.spec.ts
  - packages/quereus/test/logic/05.1-composite-pk-range-scan.sqllogic
  - packages/quereus/test/logic/05.1.1-secondary-index-range-scan.sqllogic
  - packages/quereus/test/optimizer/fd-equivalence.spec.ts
  - packages/quereus/test/optimizer/minmax-index-boundary.spec.ts
  - docs/memory-table.md
  - docs/module-authoring.md
  - docs/optimizer-costing.md
  - docs/optimizer-retrieve.md
repro: verified
----

Reported in GitHub issue #33. Equality on a leading part of a compound index or primary key now seeks that index on the memory backend, as it already did on the store backend.

```sql
create table t (k text, r integer, x integer, primary key (k, r));
select x from t where k = 'a';                          -- INDEX SEEK, was Filter over INDEX SCAN

create table d (k text, r integer not null, x integer, primary key (k, r));
create index d_kr on d (k, r desc);
select x from d where k = 'a' order by r desc limit 1;  -- INDEX SEEK, no Sort, reads one row
```

The implementer measured this on 50,000 rows with 100 distinct `k` values, mean of 20 runs after 5 warmups, in one sitting on one machine, so read these as indicative. The review did not repeat the measurement.

| Query | Before | After |
|---|---|---|
| `where k = 'k50'` (500 rows) | 63.5 ms | 2.9 ms |
| `where k = 'k50' order by r desc limit 1` | 64.2 ms | 1.3 ms |

## What was built

- **Planning.** A new arm in `evaluateIndexAccess` for equality on some leading columns, excluding a multi-value `IN`.
- **Pricing.** `estimateEqualityPrefixRows` applies the 10% fallback once per column, so a longer prefix estimates fewer rows. The prefix-range arm's rows are capped at half its equality prefix's estimate.
- **Scanning.** `buildScanPlanFromFilterInfo` turns a short equality seek into `equalityPrefix`, sharing `collectEqualityPrefix` with the prefix-range branch. `scanLayerResolved` returns early on a NULL prefix value.
- **Predicate collation gate.** A module cannot see a predicate's collation, so it takes `k = 'a' collate nocase` as pinning `k` and claims `order by r` over a BINARY `(k, r)`, although that predicate spans the groups `'A'` and `'a'`. `orderingClaimSurvivesCollation` applies the existing collation-cover analysis to the claim's index, and `planDeliversOrdering` in `rule-grow-retrieve` asks it at all three sites that let a Sort go. This also fixed a wrong result the old code already had.
- **Column collation check (added in review).** `indexColumnSortsAsDeclared` in the memory module stops an index collated differently from its column claiming that column's order, matching the store's `indexOrderMatchesDeclaredCollation`.
- **Boolean comparator (added in review).** `BOOLEAN_TYPE.compare` answers a number the way `=` does, so `flag = 1` no longer throws inside the key tree.

## Review findings

Read the diff of `ticket(implement): bug-memory-compound-index-unusable-on-leading-column` first, then the handoff. Lint and tests were run after the fixes below.

### Found and fixed in this pass

- **Regression: an error on a query that used to work.** `where flag = 1` on a boolean leading key column failed with "Inconsistent comparison function for given values", on a primary key or a secondary index, including when bound as a parameter. It used to return rows through a filter. `BOOLEAN_TYPE.compare(true, 1)` and `compare(1, true)` both answered 1, and booleans and numbers share a storage class, so that reached the tree. Whole-key and prefix-range seeks already failed this way, but this ticket extended it to the common shape of a filter on only the flag. Fixed at the comparator, which also fixes those two older forms. `flag = 0` and `flag = 2` now match the no-index results too. `sharesSeekKeySpace`'s comment and its test comment described the old comparator, so both were corrected; BOOLEAN stays out of that set. The store run passes the new boolean tests.
- **Regression: a merge join lost rows.** `x.s = y.s` with both sides seeking `(g, s collate nocase)` over a BINARY `s` returned 2 of 3 rows, because prefix seeks newly advertise monotonic order on `s` and that order is the index's, not the column's. `buildMonotonicAdvertisement` now declines in that case. With only that check disabled in a compiled copy, the query went back to a merge join and lost the row, so the logic test lines do guard it.
- **Older wrong result in the same seam.** `order by k` and `min(k)` over `index (k collate nocase)` on a BINARY `k` returned `'a'` first where `'B'` sorts first, and the reverse case was also wrong. This was not caused by this ticket. `indexSatisfiesOrdering` now uses the same check, so the Sort or full aggregate stays. Disabling the check makes `05.1.1` fail.
- **The handoff's gate was too strict.** `where k is not null order by k` on a NOCASE NOT NULL column kept a Sort that a BINARY column did not need, because a tautological null test is marked handled and was classified as a collation mismatch. Null tests are now excluded.
- **Stale comment.** The two "early termination for prefix-range" comments in `scan-layer.ts` now say prefix walk, since plain equality uses them too.

I first added the column collation check to the engine gate, then moved it to the module. The store's comments establish that a module's claim is read under the column's declared collation, and the engine gate does not cover merge join. `docs/module-authoring.md` now states that contract.

### Tests

Added only for the defects above: boolean seeks in `05.1`, the two index-versus-column collation directions in `05.1.1`, the null test plan shape in `index-selection.spec.ts`, and one general test in `type-system.spec.ts` that typed comparators give opposite answers for swapped operands across seven built-in types, which covers the class behind the boolean failure.

The implementer's tests were reviewed and none were cut. The paired `05.1` and `05.1.1` scenarios look alike but run different branches of `scanLayerResolved`. The two changed existing tests in `fd-equivalence.spec.ts` and the one in `minmax-index-boundary.spec.ts` are justified by the better plan.

### Checked, nothing found

- **Results against an identical table with no index:** a throwaway probe of 65 query shapes over 12 schemas, in 6 states each (committed, analyzed, in a transaction with writes, after a savepoint's writes, after rolling back to it, after rollback), on plain memory and through `IsolationModule`. 9,360 comparisons, no differences, on the final build. Plans were spot-checked to confirm seeks really run under isolation. The handoff's differential had not covered isolation or savepoints. The shapes deliberately left out the `desc` trailing range bug below.
- **Statements that change the rows they walk:** moving a group to another key, changing `r`, self-insert and deletes, over 200-row groups on a primary key, a secondary index and a unique index, on memory and isolation. All correct. An attempt at 3,000 rows was stopped because it was too slow, and my logs had no output to show why; the rerun with progress logging took seconds at 200 rows, so the larger size is unverified.
- **Other key types:** date, datetime, time, timespan, real, integer, blob and json, seek against no index, with same-type and cross-type literals. Only boolean differed.
- **Nullable DESC order:** `(k, r desc)` with a nullable `r` keeps its Sort, and `max` still reads through the index with the NULL filter.
- **Rows-per-key feedback:** keyed by column set, so a prefix's mean cannot be confused with a whole key's.
- **Store backend:** `yarn test:store` passes, and `05.1` and `05.1.1` were confirmed to run there.

### Parked as tripwires

- Prefix-range cost tie: on an analyzed table with a near-unique prefix, the capped range reaches 1 row and ties a unique whole-key seek at cost 0.8 (arithmetic, not run). `NOTE:` at the cap in `evaluateIndexAccess`.
- Seek leaves do not report the column they pinned as an FD or constant binding. `NOTE:` in `IndexSeekNode.computePhysical`, from the implementer.
- A multi-value `IN` on a leading part of a key stays a scan. `NOTE:` at the new arm, from the implementer.

### Filed

Nothing new. `bug-prefix-range-seek-skips-rows-on-desc-trailing-column` is already in `fix/`. It predates this ticket, but this ticket steers people towards the `(k, r desc)` index that hits it, so it should not wait long.

### Accepted, or still open

- **Visible result change under NOCASE, accepted.** `select distinct k` and `group by k` over a NOCASE-keyed group can return `'A'` where they returned `'a'`. Both are equal under the column's collation and the representative is not specified. Queries with no `order by` can also change order. Neither is a defect.
- **ASOF was still not exercised.** Four lateral top-1 shapes over `(sym, ts)`, `(sym, ts desc)` and no index returned matching rows, but all planned as ordinary joins, so no ASOF scan ran over a prefix seek. `asof-scan.spec.ts` passes.
- **Cost tie on analyzed tables, not hunted further.** The suite and the analyzed probe state pass, but plan shifts were not compared before and after.
- **Store plan shapes were not compared before and after.** The predicate gate runs for every module; only results and the suite were checked.
- **Gate coarseness kept.** A mismatched equality on any index column costs one needless Sort. It needs an explicit `collate`, a comparison between columns, or an index collated differently from its column, so it is rare and costs no correctness. The new column check has a similar cost for an index with an explicit collation on a non-text column.
- **The NULL early return has no direct test.** It changes no results, and its saving was not measured.

### Validation

- `yarn test` across all workspaces: exit 0. Engine on memory: 10,965 passing, 25 pending, 0 failing. Isolation: 445 passing.
- `yarn workspace @quereus/quereus run lint`, which covers the only package with real lint: exit 0.
- `yarn test:store`: 10,958 passing, 32 pending, 0 failing.
- The only source edit after the full `yarn test` and store runs is the comment-only `NOTE:` at the prefix-range cap. Lint and the engine suite were re-run after it, with the same counts.
