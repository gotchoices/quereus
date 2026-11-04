description: On the in-memory backend, filtering on the first column of a multi-column index or primary key reads the whole table instead of using the index, which makes common per-parent lookups cost as much as a full scan. The persistent store backend already handles this.
architecture: docs/memory-table.md
files:
  - packages/quereus/src/vtab/memory/module.ts
  - packages/quereus/src/vtab/memory/layer/scan-plan.ts
  - packages/quereus/src/vtab/memory/layer/scan-layer.ts
  - packages/quereus/test/plan/index-selection.spec.ts
  - packages/quereus/test/logic/05.1-composite-pk-range-scan.sqllogic
  - packages/quereus/test/logic/05.1.1-secondary-index-range-scan.sqllogic
  - docs/memory-table.md
repro: verified
----

Reported in GitHub issue #33. Reproduced at HEAD:

```sql
create table t (k text, r integer, x integer, primary key (k, r));
select x from t where k = 'a' and r = 1;   -- INDEX SEEK t USING primary
select x from t where k = 'a';             -- Filter over INDEX SCAN t USING _primary_

create table u (id integer primary key, k text, r integer, x integer);
create index u_kr on u (k, r);
select x from u where k = 'a';             -- Filter over INDEX SCAN u USING _primary_

create table d (k text, r integer not null, x integer, primary key (k, r));
create index d_kr on d (k, r desc);
select x from d where k = 'a' order by r desc limit 1;  -- Filter over INDEX SCAN d USING d_kr
```

Expected: equality on a leading part of a compound index or primary key seeks that index, and results do not change. The last query should become an index seek that still provides the requested order, so it reads one row.

## Cause

Nothing in the planner rule needs to change. `rule-select-access-path` already emits an equality seek for however many seek columns the module names, and the store backend relies on that. Two memory-backend sites are missing:

- **Planning.** `MemoryTableModule.evaluateIndexAccess` has an arm for equality on every index column and an arm for leading equality plus a range on the next column. Equality on only some leading columns matches neither, so it falls through to a full scan.
- **Scanning.** `buildScanPlanFromFilterInfo` turns an equality seek into a whole key. `buildCompositeEqualityKey` returns undefined when a column is unbound, and the scan then walks the whole index.

**These two must land together.** Claiming a filter makes the engine drop it from the residual, so the planning change alone turns the unbounded walk into wrong results: `where k = 'a'` would return every row.

The rest of the path is already there. `scan-layer.ts` handles `equalityPrefix`, including seeking to the start of the group and stopping at its end. It reaches the group start because the key comparators sort a shorter key before longer keys that share its values, whichever direction the columns are declared.

## Design

**Planning arm.** Add it after the leading-equality-plus-range arm, for `matchCount > 0 && matchCount < indexCols.length && !isMultiSeek`. It claims only the equality filters, names the matched columns as seek columns, and mirrors the full-key arm's `setIsSet(true)`. The existing arm's `estimateEqualityRows` must not be reused unchanged, because `isUniqueIndex` makes it answer one row per key, and a part of a unique key or primary key is not unique.

**Scan plan.** In the `isEqPlan` branch, when no whole key can be built, collect the bound leading columns into `equalityPrefix` and `equalityPrefixCollations`. Stop at the first unbound column. Share this loop with the existing prefix-range branch rather than copying it.

**Pricing.** The prefix arm is priced by the rows it is expected to match, using `AccessPlanBuilder.eqMatch(rows)` (`0.5 + 0.3 × rows`). Two changes are needed because a naive arm regressed plan choice in the experiment below:

| Query, on an un-analyzed table | Naive arm picks | Should pick |
|---|---|---|
| `k = 'a' and r > 3`, with primary key `(k, r)` and index `(k, z)` | `(k, z)` with `r > 3` as a filter (cost 30.5 against 62.8) | primary key, which narrows on both |
| `k = 'a' and r = 3`, with primary key `(k, z)` and unique index `(k, r, s)` | primary key with `r = 3` as a filter (tied at 30.5, first declared wins) | `(k, r, s)`, which narrows on both |

- A longer prefix must estimate fewer rows. `equalityTupleSelectivity` returns a flat 0.1 without statistics, whatever the column count. For this arm, combine one factor per column through `combineConjunctive` when falling back to that constant. A two-column prefix then estimates 3.2% rather than 10%: at 1000 rows, 31 rows and cost 9.8 against 100 rows and cost 30.5. Do not change the function for the existing full-key arm, whose estimates feed other plans.
- Leading equality plus a range must cost less than the same equality alone. Cap that arm's rows at half of the prefix estimate: `min(N / 8, prefixRows / 2)`. At 1000 rows that is 50 rows and cost 25.3, below 30.5. Keep the plain `N / 8` when the prefix contains a multi-value `IN`, because that plan becomes a scan anyway (see the NOTE at that arm).

These costs are arithmetic. The pricing changes were not run; the experiment used only the naive arm.

**Null seek values.** With `k = ?` bound to NULL, or a NULL outer key in a join, the plan filter rejects every row but the walk continues through the group of stored NULLs. The answer is right, but the walk is wasted. Return early from the scan when any `equalityPrefix` value is NULL.

## Experiment

A throwaway copy of the compiled engine was patched with the naive arm and the scan plan change, then compared against the unpatched build. The copy has been deleted. The repository's test suites were not run against it, so the effect on existing plan-shape tests is unknown.

- About 60 query shapes returned the same rows in every state compared: committed, inside a transaction, after rollback, and after each of the update, delete and insert-select statements. Shapes covered `DESC` leading keys, `NOCASE` columns and indexes with binary predicates, stored and bound NULLs, integer and real cross-type values, `timespan`, `json`, three-column prefixes, unique indexes, joins, correlated subqueries and aggregates.
- Wrapped in `IsolationModule`, with the patched module as both underlying and overlay, results matched as sets. One query with no `order by` returned rows in index order rather than primary-key order, which is allowed.
- `where k = 'k1' and k = 'k2'`, and the same contradiction with a single-value `IN`, stayed empty. Equality combined with a range or `OR` on the same or next column returned the same rows.
- A binary predicate over a `NOCASE` index correctly planned as the seek plus a filter.
- Timing on 50,000 rows with 100 distinct `k` values, averaged over 20 runs:

| Query | Before | After |
|---|---|---|
| `where k = 'k50'` | 39.5 ms | 4.1 ms |
| `where k = 'k50' order by r desc limit 1` over `(k, r desc)` | 62.0 ms | 1.75 ms |

## Things to check

- `buildMonotonicAdvertisement` will now advertise order on the column after the prefix, and `supportsAsofRight`, for these seeks. That order is real within one prefix value, but the experiment did not exercise a consumer. Check `test/optimizer/asof-scan.spec.ts` and the monotonic rules.
- Plans that index nested-loop joins and correlated subqueries pick can shift, because a compound prefix is now a seek candidate. A plan-shape test that fails should be judged on whether the new plan is better, not restored by default.

## Out of scope

- **A multi-value `IN` on a prefix, and runtime key sets.** `where k in ('a', 'b')` over `(k, r)` stays a scan, as does `a = 1 and b in (1, 2)` over `(a, b, c)`. The scan layer would have to treat each seek key as a prefix group, and today `orderSeekKeys` and `tree.get` assume whole keys. The `!isMultiSeek` condition keeps the key-set rewrite declining as it does now. Leave a `NOTE:` at the new arm saying so, including that `a = 1` alone could be seeked with the `IN` left as a filter.
- **Single-column full-key seeks priced too low.** An index on `(k)` costs 0.8 however many rows it matches, so for `k = 'a' and r = 1` it beats `(k, r, s)`, which narrows on both (arithmetic, not run). This already happens with any two indexes, and the NOTE at the full-key arm records why that cost was kept.
- **`order by r desc` over an ascending `(k, r)`.** This stays a seek plus a sort. `feat-reverse-index-walk-for-desc-ordering` owns reverse walks, and a note was added there about reverse prefix walks.
- **GitHub issue #32.** A table alias defeating sort absorption is tracked separately as `bug-table-alias-defeats-sort-absorption`.

## TODO

- Add the prefix arm to `evaluateIndexAccess`, with its row estimate, and a `NOTE:` for the multi-value case
- Cap the leading-equality-plus-range row estimate by the prefix estimate, keeping `N / 8` for a multi-value prefix
- Build `equalityPrefix` from short equality seeks in `buildScanPlanFromFilterInfo`, sharing the loop with the prefix-range branch
- Return early from `scanLayerResolved` for a NULL `equalityPrefix` value, on both the primary and secondary paths
- Add plan-shape tests to `test/plan/index-selection.spec.ts`: primary key prefix, secondary index prefix, a two-column prefix of three, the `(k, r desc)` order-by-limit query with no sort or filter above the seek, and the two ranking cases in the table above
- Add result tests to the two sqllogic files listed in `files:`, which also run against the store backend: first, middle, last and missing prefix groups (to catch a walk that stops early or runs past its group), a `DESC` leading key, `NOCASE` with a binary predicate, a parameter bound to NULL, and reads inside a transaction
- Update `docs/memory-table.md` (the capability list near line 88 and the query planning note near line 698)
- Run `yarn workspace @quereus/quereus test`, `yarn workspace @quereus/isolation test` and `yarn lint`; run `yarn test:store` because the new logic tests also run there
