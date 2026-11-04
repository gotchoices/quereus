description: On the in-memory backend, filtering on the first column of a multi-column index or primary key now reads only the matching rows instead of the whole table. The change also stops the engine dropping a sort it still needed when a query's text comparison rule differs from the index's.
architecture: docs/memory-table.md
files:
  - packages/quereus/src/vtab/memory/module.ts
  - packages/quereus/src/vtab/memory/layer/scan-plan.ts
  - packages/quereus/src/vtab/memory/layer/scan-layer.ts
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts
  - packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts
  - packages/quereus/src/planner/nodes/table-access-nodes.ts
  - packages/quereus/test/plan/index-selection.spec.ts
  - packages/quereus/test/logic/05.1-composite-pk-range-scan.sqllogic
  - packages/quereus/test/logic/05.1.1-secondary-index-range-scan.sqllogic
  - packages/quereus/test/optimizer/fd-equivalence.spec.ts
  - packages/quereus/test/optimizer/minmax-index-boundary.spec.ts
  - docs/memory-table.md
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

Measured on 50,000 rows with 100 distinct `k` values, mean of 20 runs after 5 warmups, in one sitting on one machine, so read these as indicative:

| Query | Before | After |
|---|---|---|
| `where k = 'k50'` (500 rows) | 63.5 ms | 2.9 ms |
| `where k = 'k50' order by r desc limit 1` | 64.2 ms | 1.3 ms |

## What was built

- **Planning.** A new arm in `evaluateIndexAccess` for equality on some leading columns, excluding a multi-value `IN`.
- **Pricing.** `estimateEqualityPrefixRows` applies the 10% fallback once per column, so a longer prefix estimates fewer rows. The prefix-range arm's rows are capped at half its equality prefix's estimate.
- **Scanning.** `buildScanPlanFromFilterInfo` turns a short equality seek into `equalityPrefix`, sharing `collectEqualityPrefix` with the prefix-range branch. `scanLayerResolved` returns early on a NULL prefix value.

## Departure from the implement ticket: the planner rule did change

The ticket said nothing in the planner rule needed to change. As specified, the change returned wrong rows that the old code got right, so I added a gate. Please review this part hardest.

A module cannot see a predicate's collation. It takes `k = 'a' collate nocase` as pinning `k`, so over a BINARY `(k, r)` it claims `order by r` is satisfied, and the Sort is dropped. The access-path rule then declines the seek on the collation mismatch and builds an unordered scan. Measured with the ticket's design, before the gate:

| Query over a BINARY `(k, r)` | Old code | Ticket's design |
|---|---|---|
| `where k = 'a' collate nocase order by r` (one spelling stored) | 1, 2, 3 | 3, 1, 2 |
| `... order by r limit 2` (one spelling stored) | 1, 2 | 3, 1 |
| `select min(r) ... where k = 'a' collate nocase` (two spellings stored) | 0 | 2 |

The new `orderingClaimSurvivesCollation` applies the existing collation-cover analysis to the index the claim rests on. `planDeliversOrdering` in `rule-grow-retrieve` asks it at all three sites that let a Sort go: Sort absorption (which `rule-minmax-index-boundary` also uses), the re-probe no-clobber guard, and growing a Sort into a Retrieve. On a mismatch the Sort stays.

This also fixes a wrong result the old code already had. With two stored spellings, `where k = 'a' collate nocase order by r` returned 0, 2, 1 because `r` restarts in each binary group. The same gate covers the store backend, since it sits above the module.

The gate is deliberately coarse: a mismatched equality on any column of the index disqualifies the claim, including a column the claim did not need. That costs one needless Sort. It needs a predicate whose collation differs from the index's and is not BINARY: an explicit `collate`, a comparison between columns, or an index declared with a different collation from its column.

## Validation

- `yarn test` across all workspaces: exit 0. Engine suite on memory: 10,963 passing, 25 pending, 0 failing. Isolation: 445 passing.
- `yarn lint`: exit 0.
- Engine suite on the store backend: exit 0. The summary line was lost to the Windows output-drop problem described in `AGENTS.md`, so I separately confirmed `05.1` and `05.1.1` ran and passed under "(Store Mode)".
- A throwaway differential probe, since deleted: 58 query shapes over 9 schemas (DESC keys, NOCASE and RTRIM, three-column and unique indexes, two competing indexes), each in four states (committed, analyzed, inside a transaction with writes, after rollback), compared against the same data with no index. 2,069 of 2,088 agree. The 19 that do not are five queries: three are the pre-existing bug below, and two are the spelling change under *For the reviewer*. The old code disagreed on eight queries.
- Each fix was broken in turn to confirm its tests catch it: removing the Sort gate, flat selectivity, removing the range cap, and not building the prefix each fail. Files were restored and the diff checksum matched afterwards.
- The one source edit after these runs is the comment-only `NOTE:` in `table-access-nodes.ts`, followed by a clean typecheck.

## Tests

Added in `test/plan/index-selection.spec.ts`, under "equality on a leading part of a compound key":

| Test | Verifies |
|---|---|
| seeks a primary key prefix | the seek is on the primary key, with no Filter above |
| seeks a secondary index prefix | the same on a secondary index |
| seeks a two-column prefix of a three-column index | a prefix longer than one column |
| serves order by + limit from the seek, reading one row | no Sort, the right row, and `rowsScanned` of 1 |
| prefers the index that also uses a range on the next column | the range cap (first row of the ticket's ranking table) |
| prefers the longer prefix over one declared earlier | the per-column fallback (second row of the table) |

Added result tests, which also run on the store backend:

| File | Verifies |
|---|---|
| `05.1-composite-pk-range-scan` | first, middle, last and missing groups; a later column left as a filter; reads through a transaction's own writes and after rollback; a DESC leading key; one and two columns of three; a gap in the key |
| `05.1.1-secondary-index-range-scan` | the same groups and transaction reads; a parameter bound to NULL not matching stored NULLs; a DESC leading key; order from a DESC column after the prefix; NOCASE with NOCASE and BINARY predicates; the Sort gate with one and two spellings, with `limit`, with a trailing range, and through `min` |

Changed, because the new plan is better rather than to restore the old one:

- `fd-equivalence.spec.ts`, two tests: their tables had no declared key, so the implicit all-column key now seeks `a`. They pin bindings on a Filter, so they now declare a key to keep the predicate in one. That file's neighbouring test already explains the same choice.
- `minmax-index-boundary.spec.ts`, one test: now expects `INDEXSEEK`, and also asserts the boundary read scans one row.

## For the reviewer: known gaps and judgement calls

- **A bug this makes easier to reach, filed and not fixed.** `k = 'a' and r > 1` over `(k, r desc)` returns no rows, and `r >= 2` returns only the boundary row. The old code does the same, so this ticket did not cause it. But this ticket's headline use case steers people towards exactly that index, so `bug-prefix-range-seek-skips-rows-on-desc-trailing-column` in `fix/` should not wait long.
- **A visible result change under NOCASE.** `select distinct k` and `group by k` over a NOCASE-keyed group can now return `'A'` where they returned `'a'`, because they walk the index rather than the table. Both spellings are equal under the column's collation and the group's representative is not specified, so I kept it. Queries with no `order by` also come back in a different order in 16 of the 2,088 comparisons.
- **The cap reaches analyzed tables too.** The ticket's arithmetic covers un-analyzed tables. With statistics, a high-distinct prefix now estimates far below `N / 8`, so prefix-range plans cost less than before on those tables. The suite and the probe's analyzed state pass, but I did not look for plan shifts specifically.
- **ASOF was not exercised over a prefix seek.** The ticket asked for monotonic consumers to be checked. Merge join and window both fired over prefix seeks with correct rows. My lateral top-1 query planned as a plain join with a Sort, so no ASOF scan ran. `asof-scan.spec.ts` passes, and `rule-lateral-top1-asof` probes the module with no filters, so the new arm should not affect it, but that last part is from reading the code.
- **The NULL early return has no direct test.** It changes no results, only how far a walk goes, and I did not measure the saving. The logic test pins the answer, which would stay right without it.
- **Store plan shapes were not inspected.** The gate runs for every module. Store tests pass, but I did not compare its plans before and after.

## Tripwires

- Seek leaves do not report the column they pinned as an FD or constant binding, though a Filter would. Parked as a `NOTE:` in `IndexSeekNode.computePhysical`. DISTINCT, GROUP BY and ORDER BY plans over a prefix seek were no worse than the old plans; other consumers of those facts were not audited.
- A multi-value `IN` on a leading part of a key stays a scan. Parked as a `NOTE:` at the new arm, as the ticket asked.
