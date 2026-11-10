description: When many separate statements write rows that share one value of an indexed column, such as a status flag, an in-memory table slows down (and, inside one transaction, uses memory) in proportion to the square of the number of statements, because each statement copies the whole list of rows filed under that value. Store one index entry per row instead, so a statement's write touches only a few tree nodes.
architecture: docs/memory-table.md#performance-characteristics
files:
  - packages/quereus/src/vtab/memory/index.ts                 # MemoryIndex: entry layout, addEntry/removeEntry, ownedEntries, sortedCache, getSortedPrimaryKeys, getPrimaryKeys, hasAnyPrimaryKey, size
  - packages/quereus/src/vtab/memory/types.ts                 # MemoryIndexEntry (and its stale structuredClone comment)
  - packages/quereus/src/vtab/memory/layer/scan-layer.ts      # secondary-index branch of scanLayerResolved; walkStartKey / lastKeyOfSeekGroup take one keyFromEntry for two jobs
  - packages/quereus/src/vtab/memory/layer/safe-iterate.ts    # re-finds by the tree key after a mutation
  - packages/quereus/src/vtab/memory/layer/manager.ts         # checkUniqueViaIndex (getPrimaryKeys); MemoryIndex construction ~line 3522
  - packages/quereus/src/vtab/memory/layer/base.ts            # addRowToIndex (hasAnyPrimaryKey); MemoryIndex construction ~line 155
  - packages/quereus/src/vtab/memory/layer/transaction.ts     # MemoryIndex construction ~lines 210, 282; stale comment ~line 198; remove-before-add order in recordUpsert ~lines 980-1010
  - packages/quereus/src/vtab/memory/utils/primary-key.ts     # PrimaryKeyFunctions.encode doc mentions MemoryIndex
  - packages/quereus/test/performance-sentinels.spec.ts       # existing "Secondary index per-entry PK container" sentinel; new sentinel goes here
  - packages/quereus/test/vtab/memory-index-pk-value-identity.spec.ts  # constructs MemoryIndex with encode; pins value-identity dedup
  - docs/memory-table.md                                      # Performance Characteristics bullet describing this bug
repro: verified
difficulty: hard
----
# One secondary-index B-tree entry per (index value, primary key) pair

## Reproduced

Built `@quereus/quereus` at HEAD (`db95d3018`) and ran, on node v24.2.0, N prepared single-row inserts `insert into t values (?, 0)` into `t (id integer primary key, g integer)` with `create index t_g on t(g)`, inside one transaction, sampling `heapUsed` after a forced GC before commit:

| N | time | retained heap |
|---|---|---|
| 2,000 | 0.20 s | 86 MB |
| 4,000 | 0.62 s | 320 MB |
| 8,000 | 2.43 s | 1,246 MB |

The same run with the index on `(id, g)` (every value distinct): 0.23 s and 55 MB at N = 8,000.

At the lowest layer: a `MemoryIndex` holding 50,000 primary keys under value `0`, then 2,000 child `MemoryIndex` objects built over its tree (the way each `TransactionLayer` wraps its parent's tree), each adding one primary key under `0`: 7.3 s. Each child copies the 50,000-entry Map.

## Cause

`MemoryIndex` stores one B-tree entry per distinct index value, `{ indexKey, primaryKeys: Map<encodedPk, pk> }`. inheritree's copy-on-write clones B-tree nodes but shares the entry objects in them, so a layer that writes under an inherited value must copy that value's whole Map (`new Map(existingEntry.primaryKeys)` in `addEntry` / `removeEntry`) before changing it. `ownedEntries` tracks which entries are this layer's own copies. One layer exists per write statement, so N statements under one value cost O(N·k).

(The `MemoryIndexEntry` comment in `types.ts` says inheritree deep-clones entries with `structuredClone`. inheritree 1.0.1 has no `structuredClone` call; the comment is stale and goes away with this change.)

## Design

Store one entry per indexed row:

```ts
/** One indexed row: the row's index key and its primary key. Immutable once stored. */
export interface MemoryIndexEntry {
	indexKey: BTreeKeyForIndex;
	primaryKey: BTreeKeyForPrimary;
}
```

The tree orders entries by `compareKeys(indexKey)`, then by the table's primary-key comparator. Probes need to land before or after every primary key of one index value, so the tree key allows a sentinel in the primary-key slot:

```ts
const PK_LOW: unique symbol;   // sorts before every primary key under equal indexKey
const PK_HIGH: unique symbol;  // sorts after every primary key under equal indexKey
type IndexTreeKey = { indexKey: BTreeKeyForIndex; primaryKey: BTreeKeyForPrimary | typeof PK_LOW | typeof PK_HIGH };
```

`keyFromEntry` is the entry itself (an entry is a valid `IndexTreeKey`). The comparator compares `indexKey` first; on a tie, equal sentinels give 0, `PK_LOW` gives -1, `PK_HIGH` gives +1, and otherwise the primary-key comparator decides.

Consequences:

- **addEntry** inserts the pair; if a comparator-equal pair is already there (same index value and same primary key), replace it with `updateAt` so the stored bytes are the row's current ones. **removeEntry** finds the pair and `deleteAt`s it. Both are O(log n) on every layer: copy-on-write clones only the touched path. `ownedEntries`, `sortedCache`, the inherited/owned branches and the `encode` constructor parameter all go away.
- **Primary-key dedup** moves from the string encoding to the primary-key comparator. `primaryKeyFunctions.encode` is documented to agree with that comparator (`utils/primary-key-encode.ts`), and the primary tree already uses the comparator for row identity, so the value-identity cases in `memory-index-pk-value-identity.spec.ts` (`true` ≡ `1` ≡ `1n`, composite `[5n, 7]` ≡ `[5, 7]`, reordered JSON objects) must still pass unchanged apart from the constructor call. Keep `encode` on `PrimaryKeyFunctions`; the scan's multi-seek dedup and `TransactionLayer`'s re-key code still use it.
- **Collation-equal primary keys**: the encoding kept NOCASE `'A'` and `'a'` as two Map keys; the comparator makes them one pair. This is fine only while every caller removes the old pair before adding the new one when a row's primary key changes to a collation-equal value (an add-then-remove would replace the pair and then delete it). `recordUpsert` in `transaction.ts` already removes first; check every other `addEntry` / `removeEntry` caller (`reindexOwnWrites`, `rekeyPrimaryKey`, base rebuilds) and leave a one-line comment at `removeEntry` stating the order requirement.
- **Collation-equal index keys** (NOCASE `'B'` vs `'b'`): each pair now keeps its own row's `indexKey` bytes, instead of the value entry keeping whichever bytes arrived first. Nothing reads those bytes back as data (scans fetch rows from the primary tree), so this is not a behaviour change; note it in the `MemoryIndexEntry` comment.
- **Read API on `MemoryIndex`** keeps its names so callers barely change:
  - `getPrimaryKeys(indexKey)` walks from `{indexKey, PK_LOW}` while `compareKeys(entry.indexKey, indexKey) === 0`. Already in primary-key order; no sort.
  - `hasAnyPrimaryKey(indexKey)` finds `{indexKey, PK_LOW}`, steps to the next entry, and compares its `indexKey`. O(log n).
  - `getSortedPrimaryKeys(entry)` is deleted; add a generator such as `primaryKeysOf(indexKey, descending)` for the scan's equality branch (descending walks backwards from `{indexKey, PK_HIGH}`).
  - `size` becomes the number of indexed rows, not distinct values. Only tests read it (`expect(index.size).to.equal(0)`); update its doc comment.
- **Scans** (`scan-layer.ts`, secondary branch). The ordered walk now yields one entry per row, so the inner `primaryKeysInWalkOrder` loop goes away and primary-key order within a value, in both directions, comes from the tree order (this is what `debt-memory-reverse-secondary-pk-order` emulated by indexing a sorted array backwards). Two adjustments:
  - The seek key handed to `safeIterate` must be an `IndexTreeKey`: wrap the index-key seek tuple as `{ indexKey: seek, primaryKey: plan.descending ? PK_HIGH : PK_LOW }`. For a full-length index key this matters: a descending walk seeking an exact value must start after that value's last row, not on its first. A seek tuple shorter than the index key already sorts before the whole group under `compareKeys` regardless of the sentinel, and `lastKeyOfSeekGroup` still handles the descending case.
  - `walkStartKey` / `lastKeyOfSeekGroup` use one `keyFromEntry` both to test group membership (needs the index key) and to produce the returned seek key (needs the tree key). Split it into two functions for the secondary branch, or have the primary branch pass the same function twice. `lastKeyOfSeekGroup`'s NOTE about one extra pass over the group now costs rows, not distinct index keys; update the NOTE's wording.
  - `safeIterate`'s re-find after a mutation now re-finds the exact pair, which is at least as precise as before. Memory scans already read a captured layer that the statement's own writes do not touch (`scanSnapshotIsolation` in `vtab/memory/module.ts`), so no new Halloween exposure.
- **UNIQUE checks** (`checkUniqueViaIndex`, `addRowToIndex`) keep calling `getPrimaryKeys` / `hasAnyPrimaryKey`; no change beyond what those now cost.
- **Freezing**: inheritree freezes stored entries by default. The pair object is never mutated after insert, and freezing is shallow, so a BLOB index key or primary key inside it is unaffected.

Rejected alternative: keep one entry per value but make `primaryKeys` a nested inheritree tree based on the parent's. That makes the copy O(1) but builds a chain of base trees one level deep per statement inside every entry (the same shape `bug-many-inserts-in-one-transaction-overflow-stack` dealt with for the main trees), and `clearBase` on a frozen layer would not reach the nested trees.

## Expected after the fix

- The lowest-layer repro above (50,000 keys under one value, 2,000 children adding one key each) runs in tens of milliseconds, not seconds.
- The SQL repro at N = 8,000 lands near the distinct-value numbers (about 0.2 s and tens of MB); time and retained memory roughly double, not quadruple, when N doubles.
- Re-measure memory at N = 8,000 with distinct values too: per-row cost changes from a Map entry plus an encoded string to one small object per row, which should not be larger. Record both numbers in the review handoff.

## TODO

- Add the reproduction as a sentinel in `test/performance-sentinels.spec.ts`, next to the existing "Secondary index per-entry PK container" block: a base `MemoryIndex` with 50,000 primary keys under one value, 2,000 children built over `base.data` each adding one key, bound generous (for example under 1 s; measured 7.3 s before the fix). Confirm it fails before the change.
- Rewrite `MemoryIndexEntry` in `types.ts` and its doc comment (pair layout, comparator-based identity, why an entry is immutable).
- Rewrite `MemoryIndex` in `index.ts`: tree key with `PK_LOW` / `PK_HIGH` sentinels, pair comparator, `addEntry` / `removeEntry` as plain insert/update/delete, `getPrimaryKeys`, `hasAnyPrimaryKey`, a `primaryKeysOf`-style generator, `size` doc. Delete `ownedEntries`, `sortedCache`, `getSortedPrimaryKeys` and the `encode` parameter.
- Update the `MemoryIndex` constructor call sites in `base.ts`, `manager.ts`, `transaction.ts`, `test/performance-sentinels.spec.ts` and `test/vtab/memory-index-pk-value-identity.spec.ts`; fix the stale comments in `transaction.ts` (~line 198) and `utils/primary-key.ts` (`encode` doc).
- Update the secondary branch of `scanLayerResolved` and the `walkStartKey` / `lastKeyOfSeekGroup` key-function split in `scan-layer.ts`, as described above.
- Audit every `addEntry` / `removeEntry` caller for remove-before-add when a primary key changes; add the comment at `removeEntry`.
- Keep the existing "per-entry PK container" sentinel passing (250,000 out-of-order adds under one value, under 2 s); it now measures B-tree inserts.
- Update `docs/memory-table.md` § Performance Characteristics: drop the quadratic caveat on the Write Performance bullet; in Current Limitations, the secondary-scan order bullet stays true and can say the order comes from the tree.
- Run `yarn workspace @quereus/quereus test` and `yarn workspace @quereus/quereus lint`. `yarn test:store` is not needed (the store backend has its own index layout). Run `yarn workspace @quereus/isolation test` too, since the isolation layer merges memory secondary scans assuming `(indexKey, pk)` order (`docs/design-isolation-layer.md`).
- Re-run the SQL repro and the distinct-value comparison and put the numbers in the review handoff.
