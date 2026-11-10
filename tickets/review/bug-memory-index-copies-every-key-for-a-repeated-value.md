description: In-memory tables slowed down, and inside one transaction used memory, in proportion to the square of the number of statements when many statements wrote rows sharing one value of an indexed column (such as a status flag). The index now stores one entry per row, so each statement's write touches only a few tree nodes; this ticket is the code review of that change.
architecture: docs/memory-table.md#performance-characteristics
files:
  - packages/quereus/src/vtab/memory/types.ts                 # MemoryIndexEntry is now {indexKey, primaryKey}; PK_LOW / PK_HIGH sentinels; IndexTreeKey
  - packages/quereus/src/vtab/memory/index.ts                 # MemoryIndex: pair comparator, addEntry (upsert) / removeEntry, primaryKeysOf, getPrimaryKeys, hasAnyPrimaryKey, size
  - packages/quereus/src/vtab/memory/layer/scan-layer.ts      # WalkKeys adapter, walkStartKey / lastKeyOfSeekGroup generic over tree key, seekSentinel, secondary branch rewrite
  - packages/quereus/src/vtab/memory/layer/interface.ts       # getSecondaryIndexTree returns BTree<IndexTreeKey, MemoryIndexEntry>
  - packages/quereus/src/vtab/memory/layer/base.ts            # constructor call, tree type, populateIndexFromRows doc
  - packages/quereus/src/vtab/memory/layer/transaction.ts     # constructor calls, tree type, comments
  - packages/quereus/src/vtab/memory/layer/manager.ts         # probe constructor call, NOTE wording
  - packages/quereus/src/vtab/memory/utils/primary-key.ts     # encode doc (no longer used by MemoryIndex)
  - packages/quereus/src/vtab/memory/utils/primary-key-encode.ts  # top doc
  - packages/quereus/test/performance-sentinels.spec.ts       # new inheriting-layers sentinel; block renamed "Secondary index rows under one value"
  - packages/quereus/test/vtab/memory-index-pk-value-identity.spec.ts  # constructor calls, comments, sortedCache describe renamed to PK-order
  - packages/quereus/test/vtab/coordinated-commit-sibling.spec.ts      # comment only
  - packages/quereus/test/logic/101-transaction-edge-cases.sqllogic    # comment only (ownedEntries reference)
  - docs/memory-table.md                                      # Write Performance bullet; secondary-scan order bullet
----
# One secondary-index B-tree entry per (index value, primary key) pair: review

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
