description: MemoryIndexEntry.primaryKeys changed from a sorted BTreeKeyForPrimary[] (binary-search add/remove — O(M) per out-of-order arrival, O(M²) to build one bucket) to a Map<string, BTreeKeyForPrimary> keyed by a lossless, type-aware PK encoding. Owned add/remove/dedup are now O(1); PK-sorted scan output is reconstructed by sort-on-read, memoized per entry in a WeakMap. The Map is pure structured-cloneable data so inheritree's structuredClone-based node COW stays safe. A new encoder (utils/primary-key-encode.ts) mirrors compareSqlValuesFast's NUMERIC storage-class equality and is arity-aware (single source of truth = createPrimaryKeyFunctions).
prereq:
files:
  - packages/quereus/src/vtab/memory/utils/primary-key-encode.ts   # NEW: encodeScalar + encodePrimaryKey (arity-aware, lossless, class-tagged)
  - packages/quereus/src/vtab/memory/utils/primary-key.ts          # PrimaryKeyFunctions.encode added, bound to pkDefinition.length
  - packages/quereus/src/vtab/memory/types.ts                      # MemoryIndexEntry.primaryKeys: Map<string, BTreeKeyForPrimary>
  - packages/quereus/src/vtab/memory/index.ts                      # encoder ctor arg; add/remove/get rewrite; getSortedPrimaryKeys (WeakMap memo); hasAnyPrimaryKey; new Map() COW; binary-search helpers removed
  - packages/quereus/src/vtab/memory/layer/scan-layer.ts           # both secondary branches iterate getSortedPrimaryKeys(entry) with inline-sort fallback
  - packages/quereus/src/vtab/memory/layer/base.ts                 # pass encode to MemoryIndex ctor (3 call sites); populateNewIndex UNIQUE probe -> hasAnyPrimaryKey
  - packages/quereus/src/vtab/memory/layer/transaction.ts          # createPrimaryKeyFunctions(schema) -> pass compare + encode to MemoryIndex ctor
  - packages/quereus/test/vtab/memory-index-pk-value-identity.spec.ts  # Map-mode + multi-entry-leaf COW + numeric/arity + sortedCache invalidation + encoder unit tests
  - packages/quereus/test/performance-sentinels.spec.ts            # container-level 250k descending-add sentinel
difficulty: hard
----

# Review: MemoryIndex per-entry PK container — lossless-encoding Map

## What changed (and why)

Each `MemoryIndexEntry` maps one secondary-index key to the set of PKs of the rows
carrying that value. The container moved from a **PK-comparator-sorted array**
(binary-search + `splice` — an out-of-order arrival into a bucket of `M` members is
O(M), so building a low-cardinality bucket is O(M²); 250k descending ids = ~4.4 s)
to a **`Map<string, BTreeKeyForPrimary>`** keyed by a lossless, type-aware PK
encoding:

- **O(1) owned add/remove/dedup** (Map set/delete/has). The 250k descending-add
  sentinel now runs in ~126 ms (was ~4.4 s).
- **Value identity preserved.** The encoding normalizes representation variants the
  PK comparator treats as equal (the NUMERIC storage class: `5n` ≡ `5` ≡ `5.0` ≡
  `true`/`1`), so dedup-by-value still holds — the property the original sorted
  array gave us over a raw JS `Set`.
- **Structured-clone safe.** A `Map` round-trips through `structuredClone` as pure
  data, so the secondary-index inheritree's node copy-on-write (which deep-clones
  stored entries) does not corrupt the container. (A class instance / nested BTree
  would not — that is the infeasibility a prior approach hit.)
- **Scan order preserved.** PK-within-index-key order is reconstructed by
  sort-on-read (`getSortedPrimaryKeys`), memoized per entry in a `WeakMap`.

### The correctness invariant (read this first)

The primary tree enforces PK uniqueness, so every pair of PKs that can coexist in
one entry is pairwise *distinct under the PK comparator*. The encoder therefore only
needs to (1) never collide two comparator-distinct PKs, and (2) collapse exactly the
NUMERIC representation variants. It is **NOT** a collation transform: two
collation-equal-but-byte-distinct TEXT values (NOCASE `'A'`/`'a'`) encode to
*different* keys — but by the uniqueness invariant they can never both be live PKs,
so they never need to dedup against each other. Removes always carry the actual
stored PK (exact bytes), so the encoding round-trips. Hence the encoder is
collation-INDEPENDENT and value-correct.

The one piece of schema knowledge required is **PK arity**, to disambiguate a
composite tuple `[1,2]` (arity 2 → encode element-wise) from a single-column
JSON-array value `[1,2]` (arity 1 → encode whole via `JSON.stringify`). Arity is
bound in `createPrimaryKeyFunctions` (single source of truth); `MemoryIndex` never
infers it.

## Validation performed

- `yarn workspace @quereus/quereus test` → **6210 passing, 9 pending**, exit 0.
- `yarn workspace @quereus/quereus lint` (eslint + `tsc -p tsconfig.test.json
  --noEmit`, which type-checks spec call sites incl. the new 4-arg MemoryIndex ctor)
  → **clean, exit 0**.
- `yarn workspace @quereus/isolation test` → **126 passing**, exit 0. Run explicitly
  because the isolation merge is the hard dependency on PK-within-key scan order (it
  is a separate workspace, NOT covered by the quereus workspace `test`).
- Targeted spec run of the two changed specs → 37 passing, including the 250k
  descending-add sentinel (126 ms, threshold 2 s).

No pre-existing failures surfaced; no `.pre-existing-error.md` written.

## Use cases / behaviors to scrutinize

**Encoder (utils/primary-key-encode.ts) — the new trust boundary.**
- NUMERIC collapse: `encodeScalar(5)===encodeScalar(5n)===encodeScalar(5.0)`;
  `1`/`1n`/`true` collide; `-0`→`0`. Non-integer reals get an `'f'` sub-tag under the
  `'i'` (NUMERIC) class so `5.5` ≠ `5` but a number never collides a string/blob.
- Cross-class non-collision via class tags: `n`/`i`/`t`/`b`/`j` for
  null/numeric/text/blob/json.
- BLOB: lowercase zero-padded hex (so `[10]` ≠ `[1,0]`). JSON: `JSON.stringify`.
- Composite injectivity via length-prefixed components (`c.length + ':' + c`):
  `[1,23]` ≠ `[12,3]`.
- Arity-1 JSON-array value encoded whole: `[true]` ≠ `[1]` (would false-merge if
  recursed element-wise). Covered by encoder unit tests + a MemoryIndex-level
  numeric-normalization test.

**Inheritree COW (the corruption class the old single-entry tests missed).** New
`multi-entry-leaf copy-on-write` test: ≥2 distinct index keys share one leaf; COW one
entry on a child; assert a *sibling* entry is still served on both child and base,
and the base's COW'd entry is unchanged. This is the regression guard against
re-introducing a non-cloneable container — please confirm it genuinely exercises a
shared leaf (it relies on inheritree packing two small entries into one node).

**Scan order.** Both secondary branches in `scan-layer.ts` (equality short-circuit
and range walk) now iterate `getSortedPrimaryKeys(entry)`, fetched from the layer's
`MemoryIndex` (so the per-entry sort memo is shared across scans on that layer), with
an inline `[...values()].sort(primaryKeyComparator)` fallback when
`layer.getSecondaryIndex` is absent.

**sortedCache invalidation.** Owned in-place add/remove calls `sortedCache.delete(entry)`
(entry identity preserved); COW produces a fresh entry whose cache slot is naturally
absent. Test: a sorted read then an in-place add re-sorts on the next read.

## Known gaps / risks for the reviewer (tests are a floor, not a ceiling)

1. **structuredClone assumption is empirical, not verified against inheritree
   internals.** I did not read inheritree's source to confirm it deep-clones stored
   entries via `structuredClone` (I trusted the ticket and the prior ticket's
   findings). The multi-entry-leaf COW test is the empirical proof the container
   survives whatever inheritree does. If inheritree ever switched to a shallow clone
   or a non-structured-clone path, owned-vs-inherited isolation could regress without
   that test failing in an obvious way — worth a glance at the inheritree version's
   node-copy code.
2. **`getSortedPrimaryKeys` returns the cached array by reference (readonly typed).**
   Callers that mutate it would corrupt the cache; `getPrimaryKeys` defensively
   `.slice()`s, and `scan-layer` only iterates. Confirm no caller mutates the
   `getSortedPrimaryKeys` result directly.
3. **Singleton PK (arity 0 → constant `"S"`).** Covered by an encoder unit test, but
   not by a full table-level integration test (a table with an empty PK definition
   AND a secondary index is an exotic combination). Low risk — at most one row exists
   — but unexercised end-to-end.
4. **Inline fallback in scan-layer is effectively dead code** (both BaseLayer and
   TransactionLayer implement `getSecondaryIndex`). It is defensive and untested;
   decide whether to keep it or assert the index is present.
5. **`yarn test:store` (LevelDB store path) was NOT run** (agent default is the
   memory-backed suite). The container lives in the memory vtab; the store module
   exercises the same MemoryIndex code via the memory layer, but if there is any
   serialization of `MemoryIndexEntry` across the store boundary, the Map shape
   should be confirmed there. Likely fine (the store persists rows, not index
   entries — indexes are rebuilt), but I did not verify.
6. **manager.ts `checkUniqueViaIndex` left unchanged** (iterates `getPrimaryKeys`,
   order-agnostic; UNIQUE buckets are ≤1 member so the sort is trivial). Its comment
   about "tracks PKs by value" remains accurate. No behavioral change intended there
   — confirm.

## Out of scope (did not touch)

- The optimizer never claimed appended-PK ordering (`indexSatisfiesOrdering` matches
  only index columns), so no planner change was needed; the sort-on-read exists
  solely for the isolation merge contract.
- No `docs/` change: `schema.md`/`types.md` do not describe the per-entry
  `primaryKeys` container (grep confirmed), so there was nothing to update.
