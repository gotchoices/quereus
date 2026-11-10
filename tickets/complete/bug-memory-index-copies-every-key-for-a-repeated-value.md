description: In-memory tables slowed down, and inside one transaction used memory, in proportion to the square of the number of statements when many statements wrote rows sharing one value of an indexed column (such as a status flag). The index now stores one entry per row, so each statement's write touches only a few tree nodes. Implemented and reviewed.
architecture: docs/memory-table.md#performance-characteristics
files:
  - packages/quereus/src/vtab/memory/types.ts
  - packages/quereus/src/vtab/memory/index.ts
  - packages/quereus/src/vtab/memory/layer/scan-layer.ts
  - packages/quereus/src/vtab/memory/layer/interface.ts
  - packages/quereus/src/vtab/memory/layer/base.ts
  - packages/quereus/src/vtab/memory/layer/transaction.ts
  - packages/quereus/src/vtab/memory/layer/manager.ts
  - packages/quereus/src/vtab/memory/utils/primary-key.ts
  - packages/quereus/src/vtab/memory/utils/primary-key-encode.ts
  - packages/quereus/test/performance-sentinels.spec.ts
  - packages/quereus/test/vtab/memory-index-pk-value-identity.spec.ts
  - docs/memory-table.md
----
# One secondary-index B-tree entry per (index value, primary key) pair

## What changed

`MemoryIndex` used to store one B-tree entry per distinct index value, holding a `Map` of every primary key under it. The B-tree's copy-on-write clones nodes but shares the entry objects in them, so a transaction layer (one per write statement) that wrote under an inherited value copied that value's whole `Map` first. N statements under one value cost O(N·k).

Now each indexed row is its own entry, `{ indexKey, primaryKey }`, immutable once stored. The tree orders by the index's `compareKeys`, then by the table's primary-key comparator. Probes put a sentinel symbol in the primary-key slot: `PK_LOW` sorts before every row under an equal index key, `PK_HIGH` after (`types.ts`). Entry identity is the pair under those two comparators. The PK string encoding (`primaryKeyFunctions.encode`) is no longer used by `MemoryIndex`; the multi-seek dedup and `TransactionLayer`'s re-key code still use it.

- `addEntry` is `tree.upsert(pair)`: an existing comparator-equal pair is replaced so the stored bytes are current. `removeEntry` is find plus `deleteAt`. Both are O(log n) on every layer. `ownedEntries`, `sortedCache`, `getSortedPrimaryKeys` and the constructor's `encode` parameter are gone.
- `primaryKeysOf(indexKey, descending)` is a generator built on `safeIterate`, so it re-finds its place if the tree changes between steps. `getPrimaryKeys` spreads it, and `hasAnyPrimaryKey` takes its first step (O(log n)).
- `size` now counts indexed rows, not distinct values. Only tests read it.
- Scan (`scan-layer.ts`): `walkStartKey` / `lastKeyOfSeekGroup` take a `WalkKeys` adapter: `seekKey` turns a seek tuple into a tree key, and `structureKey` reads an entry's index or primary key for bound and group tests. The primary branch passes identity plus the PK extractor. The secondary branch wraps seeks with a sentinel and walks one entry per row. Its equality branch uses `primaryKeysOf`. It now fetches the `MemoryIndex` via `getSecondaryIndex` (the old fallback that sorted inline for an unknown index is gone; an unknown index still throws INTERNAL).

**Going beyond the ticket, so please check this:** the ticket asked for a seek sentinel of `descending ? PK_HIGH : PK_LOW`. `seekSentinel` also takes bound exclusivity into account. An exclusive start bound (`g > 5` walking forward) seeks past all rows under 5 rather than landing on the first of them. Without this, a walk would step through and reject every row under the bound value, which is O(k) where it used to be O(1); think `where status > 0` when most rows have status 0. Results are the same either way: the mutation run that removed exclusivity still passed all 11,142 tests. So this part is a pure cost change, and no test pins it.

## Remove-before-add audit

Pair identity uses the PK comparator, so NOCASE `'A'` and `'a'` name one entry. Adding the new pair before removing the old one would replace the entry and then delete it. I checked every `addEntry` / `removeEntry` caller, and all of them remove first:
- `recordUpsert`: in-scope to out-of-scope removes only; index key changed removes then adds; same index key only adds (upsert replaces).
- `performUpdateWithPrimaryKeyChange`: `recordDelete(old)` runs before `recordUpsert(new)`.
- A collation-equal PK rewrite (`performUpdate` with `isPrimaryKeyChanged` false) goes through `recordUpsert` under the pre-image key.
- `reindexOwnWrites` removes the parent row's pair, then adds the own row's pair.
- Base rebuilds and `populateIndexFromRows` only add, into fresh trees.
- The `replace-all` maintenance diff runs its upserts first, but deletes only keys absent from the comparator-keyed new-key set, so it never deletes a collation-equal key.

The order requirement is documented on `removeEntry`.

## Measurements (node v24.2.0, built dist, forced GC before sampling)

SQL repro: prepared `insert into t values (?, 0)` N times in one transaction into `t (id integer primary key, g integer)`, with `create index t_g on t(g)`. "Distinct" uses an index on `(id, g)` instead. The script was a scratchpad file and was not committed.

| N | before: time / retained heap | after: time / retained heap |
|---|---|---|
| 2,000 same value | 0.20 s / 85.7 MB | 0.07 s / 12.2 MB |
| 4,000 same value | 0.53 s / 321.8 MB | 0.11 s / 24.6 MB |
| 8,000 same value | 2.07 s / 1,247.5 MB | 0.19 s / 49.8 MB |
| 16,000 same value | (not run) | 0.37 s / 101.9 MB |
| 8,000 distinct | 0.20 s / 55.8 MB | 0.20 s / 52.1 MB |
| 16,000 distinct | (not run) | 0.40 s / 106.5 MB |

Both cases are now linear in N. With distinct values, memory per row is slightly lower than before.

Lowest-layer sentinel (a 50,000-PK base index, then 2,000 sibling child indexes over `base.data`, each adding one PK under the same value): 6,625 ms before, 68 ms after.

## Tests

- Added `performance-sentinels.spec.ts` › "Secondary index rows under one value" › "2,000 inheriting layers each adding one PK under a 50k-PK value take under 1 s". This is the bug's reproduction at the lowest layer, and it failed before the change (6.6 s). The existing 250k out-of-order sentinel in the same block still passes (240 ms); it now measures B-tree inserts.
- `memory-index-pk-value-identity.spec.ts`: the only changes are the constructor calls, comments, and a rename of the `sortedCache invalidation` describe to "primary-key order within an index value" (same assertions). All value-identity cases pass unchanged: `true` ≡ `1` ≡ `1n`, `[5n, 7]` ≡ `[5, 7]`, reordered JSON objects, and copy-on-write isolation from the base.
- No new scan test. Mutation checks showed existing sqllogic files already pin the sentinel choice for inclusive starts. Forcing `PK_LOW` always fails `10.5.3-desc-index-ordering.sqllogic:179` (`order by r desc` loses the row at the bound). Forcing `PK_HIGH` always fails `05.1.1-secondary-index-range-scan.sqllogic:250`.
- Ran `yarn workspace @quereus/quereus test` (11,142 passing, 26 pending), `yarn workspace @quereus/quereus lint` (clean), and `yarn workspace @quereus/isolation test` after rebuilding the quereus dist (453 passing). Did not run `yarn test:store`; the store backend has its own index layout.

## Things a reviewer might probe

- Per-row work in a secondary range walk: `planAppliesToKey` now runs once per row instead of once per distinct value. It is cheap next to the `primaryTree.get` each row already pays, but it is extra work for wide duplicate groups.
- `lastKeyOfSeekGroup` (a backwards walk that seeks a tuple shorter than the index key) now makes its extra pass over a group's rows rather than its distinct values. Its NOTE says this and gives the fix if a profile ever shows it.
- inheritree branch partitions hold entry objects as keys, because the entry is its own key. After an in-place `upsert` of a comparator-equal pair, a partition may still hold the old object. That is harmless because the two are comparator-equal, but it is a non-obvious reference.
- Collation-equal index values now keep each row's own `indexKey` bytes, where the per-value entry kept whichever arrived first. Nothing reads those bytes back as data, and the `MemoryIndexEntry` comment says so.
- The backlog ticket `debt-index-seek-matches-unindexed-query-property` (a property test comparing indexed and unindexed query results) would cover this seek logic broadly. It is not a prerequisite.

## Review findings

I read the diff of `ticket(implement): bug-memory-index-copies-every-key-for-a-repeated-value` before the handoff, along with inheritree's `upsert`, node-clone and freeze code (`node_modules/inheritree/dist`), and `safe-iterate.ts`.

- **Correctness: copy-on-write isolation.** inheritree's leaf `clone` copies the entries array shallowly and shares the entry objects. `upsert` either replaces the array slot in a leaf this tree owns, or inserts. Neither one writes into a shared entry object, so the old ownership bookkeeping (`ownedEntries`) is not needed. No problem found.
- **Correctness: the order of remove before add.** I checked the remove-before-add audit against `TransactionLayer.recordUpsert` / `recordDelete` / `reindexOwnWrites` and against the PK-change path in `manager.ts` (`recordDelete(new)`, then `recordDelete(old)`, then `recordUpsert(new)`). It holds. No problem found.
- **Correctness: seek sentinels.** I reasoned through all four combinations of walk direction and bound exclusivity in `seekSentinel`, plus the short-tuple and `lastKeyOfSeekGroup` paths, against the composite `compareKeys`, which sorts a shorter tuple first. All of them are right whatever the column's `DESC` setting. I also ran a throwaway cross-check that was not committed. It compared a table that has single-column, composite-`DESC`/NOCASE and NOCASE-`DESC` indexes against the same table with no indexes: 600 rows heavy with duplicates and case variants, committed in batches, then deletes and updates in an open transaction. That came to 1,975 query pairs covering `<`, `<=`, `>`, `>=` and `=`, equality prefixes plus bounds, and five orderings. There were 0 mismatches, and `query_plan` confirmed the index range and seek paths were chosen. No problem found.
- **Correctness: mutation during iteration.** `primaryKeysOf` and the range walk both re-find through `safeIterate`, using the whole entry as the key, so they recover even when the current entry has been deleted. No problem found.
- **Stale comments (minor, fixed).** In `transaction.ts`, the comment on `recordUpsert`'s same-index-key branch still described the old copy-on-write of whole entries; I rewrote it. In `manager.ts`, the `checkUniqueViaIndex` comment still said "the entry now tracks PKs by value"; I reworded it for the one-entry-per-row layout.
- **Tripwire (parked at the site).** The same-index-key branch of `recordUpsert` re-files the entry on every update, even when no indexed column changed. That copies one path per index, per row, per statement layer. It is O(log n) and so cheaper than before. I left a `NOTE:` in `transaction.ts`: nothing reads the stored bytes back, so the call can be skipped if it ever shows up in a profile.
- **Tripwire (parked at the site).** A forward walk from an exclusive bound with a tuple shorter than the index key (`a = 1 and b > 5` over an index on (a, b, c)) now steps through and rejects every row under (1, 5), where before it skipped each distinct value. I left a `NOTE:` on `seekSentinel` in `scan-layer.ts` that points to `lastKeyOfSeekGroup`'s existing NOTE for the fix.
- **Handoff probes I accepted as they stand.** Running `planAppliesToKey` once per row, the extra pass in `lastKeyOfSeekGroup` (already NOTEd), inheritree branch partitions keeping a replaced but comparator-equal entry object, and stored index-key bytes per row: none of these change results, and none costs more than the per-row `primaryTree.get` that already runs.
- **The exclusive-bound sentinel goes beyond the ticket, and no test pins it.** It is a cost-only behaviour: results are identical without it. I did not add a timing sentinel for it, because the per-row cost it avoids is already documented in `seekSentinel`'s doc comment, and the backlog property test `debt-index-seek-matches-unindexed-query-property` covers correctness.
- **Tests.** The new inheriting-layers sentinel is a valid reproduction of the bug at the lowest layer. The value-identity spec still pins real past defects (composite and bigint PK identity, isolation from the base) and the PK-order scan contract. I cut nothing and added nothing.
- **Docs.** `docs/memory-table.md` (the write-performance and scan-order bullets) is accurate. I grepped `docs/` and the package READMEs for the old names (`ownedEntries`, `sortedCache`, `getSortedPrimaryKeys`, `primaryKeys`) and found nothing stale.
- **Type safety, resource cleanup, error handling.** No `any` was introduced, and the entry fields are `readonly`. `hasAnyPrimaryKey` leaves a suspended generator for garbage collection, which holds no resources. An unknown index name still throws INTERNAL. No problem found.
- **Validation.** `yarn workspace @quereus/quereus lint` is clean, and `yarn workspace @quereus/quereus test` gives 11,142 passing, 26 pending. My own changes are comments only, so I did not re-run `@quereus/isolation` (453 passing in implement).
