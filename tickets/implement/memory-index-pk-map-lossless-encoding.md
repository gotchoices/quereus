description: Replace each MemoryIndex entry's sorted `primaryKeys` array with a `Map` keyed by a type-aware LOSSLESS PK encoding (Alternative C, human-signed-off). Restores O(1) owned add/remove/dedup (fixing the out-of-order DML O(M²) cliff) while staying structured-cloneable plain data so inheritree's `structuredClone`-based node COW is safe. PK-sorted scan output is preserved via sort-on-read with a per-index memoization cache.
prereq:
files:
  - packages/quereus/src/vtab/memory/types.ts                          # MemoryIndexEntry.primaryKeys: Map<string, BTreeKeyForPrimary>
  - packages/quereus/src/vtab/memory/index.ts                          # add/remove/get rewrite; ownedEntries COW via new Map(); sortedCache WeakMap; hasAnyPrimaryKey; getSortedPrimaryKeys
  - packages/quereus/src/vtab/memory/utils/primary-key.ts              # add `encode` to PrimaryKeyFunctions (arity-aware lossless encoder)
  - packages/quereus/src/vtab/memory/utils/primary-key-encode.ts       # NEW: encodeScalar + composite join; the lossless encoder core
  - packages/quereus/src/vtab/memory/layer/scan-layer.ts               # iterate getSortedPrimaryKeys(entry) instead of `entry.primaryKeys` (both equality + range branches)
  - packages/quereus/src/vtab/memory/layer/base.ts                     # populateNewIndex UNIQUE check uses hasAnyPrimaryKey (no sort); pass pkFunctions.encode to MemoryIndex ctor
  - packages/quereus/src/vtab/memory/layer/transaction.ts              # pass pkFunctions.encode to MemoryIndex ctor
  - packages/quereus/src/vtab/memory/layer/manager.ts                  # checkUniqueViaIndex iterates getPrimaryKeys (unchanged contract; order-agnostic)
  - packages/quereus/src/util/comparison.ts                            # compareSqlValuesFast NUMERIC storage-class semantics the encoder must mirror (reference only)
  - packages/quereus-isolation/src/isolated-table.ts                   # WHY sort order is mandatory: merges overlay+underlying secondary scans assuming (indexKey, PK) order
  - packages/quereus/test/vtab/memory-index-pk-value-identity.spec.ts  # extend: Map-mode value identity + MULTI-entry-leaf COW (single-entry leaves mask the corruption class)
  - packages/quereus/test/performance-sentinels.spec.ts                # add the container-level descending-add sentinel (snippet below)
difficulty: hard
----

# MemoryIndex per-entry PK container: lossless-encoding Map

## Goal

Each `MemoryIndexEntry` maps one secondary-index key to the set of primary keys
(PKs) of the rows carrying that index value. Today that set is a
`BTreeKeyForPrimary[]` kept sorted under the table's PK comparator; add/remove are
binary-search + `splice`, so an out-of-order PK arrival into a low-cardinality
bucket of `M` members costs O(M) per op → O(M²) to build the bucket (250k
descending-id inserts into one bucket = ~4.4 s; see the parked plan ticket's
profiling). Build/consolidation paths are already O(N) (they append in PK order)
and must NOT regress.

Replace the sorted array with a **`Map<string, BTreeKeyForPrimary>`** keyed by a
**lossless, type-aware PK encoding**:

- The `Map` survives `structuredClone` (round-trips as a `Map`), so it is safe as
  a value inside the secondary-index `inheritree` BTree, whose node COW deep-clones
  stored entries via `structuredClone(this.entries)`. (A class instance or a nested
  BTree is NOT safe — that is the infeasibility the prior attempt hit.)
- Owned add/remove/dedup become **O(1)** (Map set/delete/has).
- Membership/dedup is by *value* (the encoding normalizes representations, e.g.
  `5n` and `5`), preserving the value-identity correctness the sorted array gave us
  over the original JS `Set`.

PK-sorted scan output (mandatory — see "Scan order") is reconstructed by
**sort-on-read** under the PK comparator, memoized per entry to keep repeated
scans at the original amortized cost.

## Why a lossless encoding is value-correct (the invariant)

The primary tree enforces PK uniqueness: every PK that can coexist is pairwise
*distinct under the PK comparator*. So the encoder only needs to:

1. **never collide two comparator-distinct PKs** (injectivity within the index's PK
   domain), and
2. **collapse representation variants the comparator treats as equal** — exactly
   the NUMERIC storage class (`5n` ≡ `5` ≡ `5.0` ≡ `true`/`1`), so a `remove(5)` of
   a stored `5n` and a re-`add` of an equal value dedup correctly.

It is NOT a collation transform. Two collation-EQUAL-but-byte-distinct values
(NOCASE `'A'`/`'a'`; a custom-collation `'café'`/`'cafe'`) encode to *different*
keys — but by the uniqueness invariant they can never both be live PKs, so they
never need to dedup against each other. Removes always carry the actual stored
row's PK (exact bytes), so the encoding round-trips. Hence a lossless encoder is
collation-INDEPENDENT and value-correct. This is why the original ticket's
"canonical-string map is collation-incorrect" objection does not apply to a
*lossless* (vs collation-canonical) encoding.

## The encoder (`utils/primary-key-encode.ts` + `PrimaryKeyFunctions.encode`)

The encoder must mirror `compareSqlValuesFast`'s storage-class equality
(`util/comparison.ts`): NULL < NUMERIC < TEXT < BLOB < OBJECT(JSON); booleans and
bigints live in NUMERIC; JSON compares by `JSON.stringify`.

It needs exactly **one** piece of schema knowledge — the **PK arity** — to
disambiguate a composite PK tuple `[1,2]` (arity 2, encode element-wise) from a
single-column JSON-array *value* `[1,2]` (arity 1, encode the whole array via
`JSON.stringify`). Element-wise recursion on a single JSON value would false-merge
`[true]` and `[1]` (distinct under JSON `stringify`, equal under numeric
normalization). Arity comes from `schema.primaryKeyDefinition.length`, so add the
encoder to `createPrimaryKeyFunctions` (single source of truth for arity):

```ts
export interface PrimaryKeyFunctions {
  extractFromRow: (row: Row) => BTreeKeyForPrimary;
  compare: (a: BTreeKeyForPrimary, b: BTreeKeyForPrimary) => number;
  encode: (pk: BTreeKeyForPrimary) => string;   // NEW
}
```

**`encodeScalar(v: SqlValue): string`** — single column value, class-tagged, never
element-recurses:

| value                               | encoding                                              |
|-------------------------------------|-------------------------------------------------------|
| `null`                              | `"n"`                                                 |
| boolean / bigint / number (NUMERIC) | `"i" + canonicalNumeric(v)` (see below)               |
| string (TEXT)                       | `"t" + v`                                             |
| `Uint8Array` (BLOB)                 | `"b" + <lowercase hex of bytes>`                      |
| JSON object/array (OBJECT)          | `"j" + JSON.stringify(v)`                             |

`canonicalNumeric(v)`: normalize so comparator-equal numerics collide.
- boolean → `v ? 1n : 0n`.
- bigint → as-is.
- number: if `Number.isFinite(v) && Number.isInteger(v)` → `BigInt(v)` (so `5.0`,
  `5`, and `5n` all → `"5"`; `-0` → `0n` → `"0"`); else (non-integer real) →
  encode as `"f" + String(v)` (a real never equals a bigint, so the distinct
  sub-tag is safe; guards `Infinity`/`NaN`, which are not valid PKs but must not
  throw via `BigInt()`).
- For the integer path the value is `"i" + bigint.toString()`; for the real path
  `"i" + ("f" + String(v))` — i.e. keep them both under the `"i"` class tag so a
  number never collides a string/blob, but distinguishable from each other.

**`encodePrimaryKey(pk, arity)`**:
- arity 0 (singleton PK, `extractFromRow` returns `[]`) → constant `"S"` (at most
  one row exists; all map to one key).
- arity 1 → `"1" + encodeScalar(pk)`.
- arity N>1 → `pk` is the tuple array; emit `"C" + N` then, for each component
  `c = encodeScalar(pk[i])`, append `c.length + ":" + c` (length-prefix → injective
  concatenation).

The encoder is self-contained (no collation, no per-column comparator). Unit-test
it directly (see tests).

## Container shape (`types.ts`)

```ts
export interface MemoryIndexEntry {
  indexKey: BTreeKeyForIndex;
  /** Lossless-PK-encoding → the actual stored PK. Pure structured-cloneable data:
   *  a Map round-trips through structuredClone, so inheritree node COW is safe. */
  primaryKeys: Map<string, BTreeKeyForPrimary>;
}
```

The Map VALUE is the real `BTreeKeyForPrimary` (so scans yield real PKs and the
PK comparator can sort them); the KEY is its encoding (for O(1) dedup/membership).

## Wiring into `MemoryIndex` (`index.ts`)

The constructor gains the encoder alongside the comparator (thread
`pkFunctions.encode` from `base.ts` / `transaction.ts`; update test helpers). Keep
the `ownedEntries` WeakSet COW discipline; the container clone is now `new
Map(existing)` (was `existing.slice()`).

- **`addEntry(indexKey, pk)`**:
  - owned entry → `entry.primaryKeys.set(this.encode(pk), pk)`; `this.sortedCache.delete(entry)`.
  - inherited entry → COW: `const m = new Map(existing.primaryKeys); m.set(enc, pk);`
    build `updated = { indexKey: existing.indexKey, primaryKeys: m }`; `ownedEntries.add(updated)`;
    `data.updateAt(path, updated)`. (New entry object ⇒ no stale sortedCache.)
  - absent → `{ indexKey, primaryKeys: new Map([[enc, pk]]) }`; own + `insert`.
- **`removeEntry(indexKey, pk)`**:
  - owned → `entry.primaryKeys.delete(enc)`; if `entry.primaryKeys.size === 0` →
    `deleteAt`; else `this.sortedCache.delete(entry)`.
  - inherited → COW the Map, delete, then `deleteAt` if empty else `updateAt`.
- **`getSortedPrimaryKeys(entry): readonly BTreeKeyForPrimary[]`** (NEW): memoized
  sort.
  ```ts
  private sortedCache = new WeakMap<MemoryIndexEntry, BTreeKeyForPrimary[]>();
  getSortedPrimaryKeys(entry) {
    let s = this.sortedCache.get(entry);
    if (!s) { s = [...entry.primaryKeys.values()].sort(this.primaryKeyComparator);
              this.sortedCache.set(entry, s); }
    return s;
  }
  ```
  Owned mutation invalidates by `delete(entry)` (entry identity unchanged); COW
  produces a fresh entry object, so its cache entry is naturally absent. The cache
  is per-MemoryIndex (per layer) and never serialized — entries stay pure data.
- **`getPrimaryKeys(indexKey): BTreeKeyForPrimary[]`**: `entry ?
  getSortedPrimaryKeys(entry).slice() : []` (preserve the sorted defensive-copy
  contract existing callers rely on).
- **`hasAnyPrimaryKey(indexKey): boolean`** (NEW): `(data.get(indexKey)?.primaryKeys.size ?? 0) > 0`.
  Used by the build-time UNIQUE check so it does NOT sort per row.
- `get size()` (distinct index-key count) and `clearBase()` unchanged.

## Scan order (mandatory — do not emit insertion order)

`scan-layer.ts` currently iterates `for (const pk of indexEntry.primaryKeys)`,
relying on the array being PK-sorted, in BOTH the equality branch (~line 181) and
the range-walk branch (~line 252). This order is **observable and depended upon**:
`quereus-isolation`'s `isolated-table.ts` merges the overlay scan with the
underlying memory scan using sort key `[indexKeyParts…, pkParts…]` and explicitly
assumes "both streams are in the same order" — an insertion-order Map would break
the merge (dropped/duplicated rows). The optimizer itself never claims the
appended-PK ordering (`memory/module.ts indexSatisfiesOrdering` matches only index
columns), but the isolation merge makes PK-within-key order a hard requirement.

Change both branches to fetch sorted PKs from the MemoryIndex:
```ts
const idx = layer.getSecondaryIndex?.(plan.indexName);
const pks = idx ? idx.getSortedPrimaryKeys(indexEntry)
                : [...indexEntry.primaryKeys.values()].sort(primaryKeyComparator);
for (const pk of pks) { const value = primaryTree.get(pk); if (value) yield value as Row; }
```
(Both BaseLayer and TransactionLayer implement `getSecondaryIndex`; the inline
sort is a defensive fallback. `primaryKeyComparator` is already in scope.)

## Build path (must stay O(N))

`base.ts populateNewIndex` gates the UNIQUE check on
`newIndex.getPrimaryKeys(indexKey).length > 0` — that would sort the bucket on
every row during a build. Replace with `newIndex.hasAnyPrimaryKey(indexKey)`
(unsorted, O(1)). `addEntry` itself is O(1) (Map set), so the ascending append
build stays O(N). `manager.ts checkUniqueViaIndex` iterates `getPrimaryKeys`
(order-agnostic; UNIQUE buckets are ≤1 member so the sort is trivial) — leave as
is.

## Edge cases & interactions

- **MULTI-entry-leaf COW (the corruption class the old tests missed).** Build a
  `base` index with ≥2 distinct index keys (so they share one inheritree leaf);
  create a child inheriting `base.data`; COW one entry on the child; assert a
  *sibling* entry still serves its PKs through the child AND `base` is unchanged.
  With a `Map` container this must pass (structuredClone round-trips a Map); it is
  the regression guard against re-introducing a class/BTree container.
- **Value identity in Map mode** (port every existing array-mode case): composite
  PK add/remove by a fresh equal-by-value array; `5n`/`5` dedup on add and removal
  across representations; genuinely-distinct composite PKs retained; emptied entry
  removed from the tree (`size → 0`).
- **Inherited COW isolation** (the three existing cases): inherited add of a
  distinct PK, inherited remove that empties, inherited add of an already-present
  PK — child sees the change, base untouched; now exercised through the Map clone
  (`new Map(existing)`) rather than `slice()`.
- **Numeric normalization correctness**: `true` vs `1` vs `1n` collide (one bucket
  member); `[true]` vs `[1]` as a single-column JSON-array PK do NOT collide
  (arity-1 JSON path). Composite `[5n,'a']` vs `[5,'a']` collide.
- **Cross-class non-collision**: number `5` (`"i5"`), string `"5"` (`"t5"`), blob,
  JSON never collide (class tags).
- **BLOB / JSON PKs**: lossless hex / `JSON.stringify` keys; distinct values stay
  distinct; equal values dedup. (JSON values never contain bigint — `JSON.stringify`
  would throw — so the OBJECT path never sees the numeric-normalization ambiguity.)
- **Singleton PK (empty PK definition)**: arity 0 → constant `"S"` key; at most one
  PK; add/remove behaves.
- **sortedCache invalidation**: an owned add/remove must invalidate before the next
  scan; verify a scan after an in-place add reflects the new PK in sorted position
  (not a stale cached array).
- **Layer collapse / consolidation**: `clearBase()` and commit-consolidation
  rebuild from the primary tree (ascending) via `addEntry`; entries remain plain
  `{indexKey, Map}` data; no cache leaks across the collapse (cache is per
  MemoryIndex, discarded with the layer).
- **Partial index predicate**: add/remove still gated by `rowMatchesPredicate`
  upstream; container change is orthogonal.
- **Deep base-chain (many uncommitted layers)**: each cross-layer first-touch COW
  is O(M) (`new Map`), inherent and accepted; owned ops after the touch are O(1).

## Performance sentinel (drop into `performance-sentinels.spec.ts`)

Container-level descending add (dodges SQL-pipeline noise). The old sorted array
fails (~4.4 s); the Map passes well under 2 s. Update the import paths / construction
to match the new constructor signature (it now also takes `pkFunctions.encode`):

```ts
describe('Secondary index per-entry PK container', function () {
  this.timeout(120_000);
  it('builds a single-key bucket of 250k out-of-order PKs under 2 s', () => {
    const columns = [
      { ...createDefaultColumnSchema('status'), logicalType: INTEGER_TYPE },
      { ...createDefaultColumnSchema('id'), logicalType: INTEGER_TYPE },
    ];
    const schema = { name: 'orders', schemaName: 'main', columns,
      columnIndexMap: new Map(columns.map((c, i) => [c.name.toLowerCase(), i])),
      primaryKeyDefinition: [{ index: 1 }], checkConstraints: [],
      vtabModuleName: 'memory', isView: false } as any;
    const pk = createPrimaryKeyFunctions(schema);
    const index = new MemoryIndex({ name: 'ix_status', columns: [{ index: 0 }] },
      columns, pk.compare, pk.encode);
    const N = 250_000;
    const start = performance.now();
    for (let i = N; i >= 1; i--) index.addEntry(0, i);   // descending => array-front splice worst case
    const elapsed = performance.now() - start;
    expect(index.getPrimaryKeys(0)).to.have.length(N);
    expect(elapsed).to.be.below(2000, `250k out-of-order PK adds took ${elapsed.toFixed(1)} ms`);
  });
});
```
(If the MemoryIndex constructor keeps a 3-arg form for tests, prefer extending it
to accept the encoder; do not infer arity inside MemoryIndex — it lacks the PK
definition.)

## TODO

- [ ] Add `utils/primary-key-encode.ts`: `encodeScalar(v)` and a composite-aware
      `encodePrimaryKey(pk, arity)` per the encoder spec. Pure, no schema/collation.
- [ ] Extend `createPrimaryKeyFunctions` (`utils/primary-key.ts`) to also return
      `encode`, binding arity from `pkDefinition.length` (handle arity 0/1/N).
- [ ] `types.ts`: change `MemoryIndexEntry.primaryKeys` to
      `Map<string, BTreeKeyForPrimary>`; update the doc comment to explain the
      structured-clone-safety rationale and value-by-encoding semantics.
- [ ] `index.ts`: accept the encoder in the constructor; rewrite
      `addEntry`/`removeEntry`/`getPrimaryKeys`; add `getSortedPrimaryKeys`
      (WeakMap memo) and `hasAnyPrimaryKey`; clone via `new Map(existing)`; drop the
      `findPrimaryKeyPosition`/`insertPrimaryKey`/`removePrimaryKey` binary-search
      helpers.
- [ ] `base.ts` + `transaction.ts`: pass `pkFunctions.encode` into every
      `new MemoryIndex(...)`. `base.ts populateNewIndex`: swap the UNIQUE-check
      probe to `hasAnyPrimaryKey`.
- [ ] `scan-layer.ts`: both equality and range branches iterate
      `getSortedPrimaryKeys(indexEntry)` (with inline-sort fallback).
- [ ] Extend `memory-index-pk-value-identity.spec.ts`: add the MULTI-entry-leaf
      COW test (sibling entry served correctly + base untouched), and the
      numeric-normalization / arity-1-JSON cases. Add a small unit-test block for
      the encoder (cross-class non-collision, numeric collapse, composite injectivity,
      BLOB/JSON round-trip).
- [ ] Add the container sentinel to `performance-sentinels.spec.ts`.
- [ ] Run `yarn workspace @quereus/quereus test` and `yarn workspace
      @quereus/quereus lint` (lint type-checks spec call sites — the MemoryIndex
      constructor signature change will surface here). Stream with `tee`.
- [ ] If `docs/` (schema.md / types.md) describes the per-entry `primaryKeys`
      array, update the description to the Map container.
