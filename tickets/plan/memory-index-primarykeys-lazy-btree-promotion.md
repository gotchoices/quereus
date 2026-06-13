description: BLOCKED on a design question needing human sign-off — the prescribed design (give each MemoryIndexEntry a `PrimaryKeySet` container that promotes a sorted array to a per-entry `inheritree` BTree) is INFEASIBLE as specified. `inheritree` performs node-level copy-on-write by `structuredClone`-ing the stored entries (`LeafNode.clone` → `structuredClone(this.entries)`), so `MemoryIndexEntry.primaryKeys` MUST be structured-cloneable plain data. A nested `BTree` throws `DataCloneError` (its `keyFromEntry`/`compare` are functions); even a plain class wrapper is silently corrupted (structuredClone strips the prototype, so sibling entries in a multi-entry leaf become method-less objects after a COW). The performance cliff IS real but narrower than the original ticket assumed (build/consolidation are already O(N); only out-of-order steady-state DML into a low-cardinality bucket is O(N²)), and the COW path is inherently O(M) per cross-layer touch regardless of container. Human must choose among the viable alternatives below before any code lands.
prereq:
files:
  - node_modules/inheritree/dist/nodes.js                          # ROOT CAUSE: LeafNode.clone/BranchNode.clone do structuredClone(this.entries)
  - packages/quereus/src/vtab/memory/index.ts                      # MemoryIndex.addEntry/removeEntry/getPrimaryKeys + ownedEntries COW; the sorted-array splice that pays O(M) per out-of-order add
  - packages/quereus/src/vtab/memory/types.ts                      # MemoryIndexEntry.primaryKeys: BTreeKeyForPrimary[] (MUST stay structured-cloneable)
  - packages/quereus/src/vtab/memory/layer/scan-layer.ts           # `for (const pk of indexEntry.primaryKeys)` — relies on PK-sorted iteration order
  - packages/quereus/src/vtab/memory/layer/base.ts                 # populateNewIndex / populateSecondaryIndexes — the ASCENDING (append) build path: already O(N), no cliff
  - packages/quereus/src/vtab/memory/layer/transaction.ts          # recordUpsert add/removeEntry — the out-of-order steady-state DML path that pays the O(N²)
  - packages/quereus/src/vtab/memory/utils/primary-key.ts          # createPrimaryKeyFunctions().compare — the PK comparator; PK-tree uniqueness is the invariant that makes a lossless-encoding Map correct (alt C)
  - packages/quereus/test/performance-sentinels.spec.ts            # where the sentinel belongs (see ready-to-use snippet below)
  - packages/quereus/test/vtab/memory-index-pk-value-identity.spec.ts   # existing COW tests pass with single-entry leaves — they MASK the corruption; any new container needs a MULTI-entry-leaf COW test
difficulty: hard
----

## BLOCKED — design question needing human sign-off

The original implement ticket prescribed a specific design (a `PrimaryKeySet`
class per entry that lazily promotes a sorted array to a nested `inheritree`
`BTree`). That design was implemented and **proven infeasible during
implementation** by a deterministic runtime failure. The original spec is
preserved verbatim at the bottom; **do not resume it unchanged** — pick one of
the alternatives below first.

All source/test changes from the attempt have been reverted; the working tree is
clean and green (typecheck exit 0, `memory-index-pk-value-identity` 8/8 passing).

---

## Root cause: inheritree node COW uses `structuredClone`

`MemoryIndexEntry` objects are stored **as values** in an `inheritree` `BTree`
(`MemoryIndex.data`). On copy-on-write, `inheritree` clones the affected leaf
node by deep-cloning its entries:

```js
// node_modules/inheritree/dist/nodes.js
clone(newTree) { return new LeafNode(structuredClone(this.entries), newTree); }
```

Therefore **every value stored in a secondary-index BTree must be
structured-cloneable plain data**. The status-quo `primaryKeys: BTreeKeyForPrimary[]`
is a plain array → clones fine (it deep-copies the bucket, O(M), on each COW
touch). The prescribed container is not:

- **Nested `BTree` (tree mode):** `structuredClone` throws
  `DataCloneError: pk => pk could not be cloned` — the per-entry BTree's
  `keyFromEntry`/`compare` are functions, which `structuredClone` cannot clone.
- **Any class instance (even array mode):** `structuredClone` does NOT preserve
  the prototype — it produces a method-less plain object. After a COW that
  touches a leaf holding ≥2 entries, the *sibling* entries (not the one being
  updated) become `{arr, tree, _size}` plain objects, so the next
  `entry.primaryKeys.toArray()` / `.add()` throws `is not a function`.

### Why the existing tests did not catch it

`memory-index-pk-value-identity.spec.ts` exercises COW only with **single-entry**
trees. In `updateAt`, the leaf is `structuredClone`d (corrupting the old entry)
and then the target slot is replaced by the real `updated` entry — so with one
entry the corrupted clone is immediately discarded and the test passes. Both
failure modes were reproduced directly during this attempt (and the repros
deleted along with the rest of the attempt):

1. **Tree mode (via SQL):** single transaction, descending-id inserts into one
   low-cardinality bucket → promotion → a cross-statement COW `updateAt` →
   `DataCloneError`.
2. **Array mode (multi-entry leaf, direct MemoryIndex):** `base` with 3 distinct
   index keys (one leaf), `child` inherits `base.data`, `child.addEntry` COWs one
   entry → `child.getPrimaryKeys(siblingKey)` throws
   `TypeError: entry.primaryKeys.toArray is not a function`.

`inheritree` exposes **no** hook to customize entry cloning, so there is no
escape hatch that keeps a class/BTree inside the entry.

---

## Empirical findings (profiled this run; numbers on dev hardware)

The decision-gate profiling overturned two premises of the original ticket.

**1. The build/consolidation paths are already O(N), not O(N²).**
`populateSecondaryIndexes` / `populateNewIndex` / commit-consolidation iterate
the primary tree **ascending**, so PKs arrive at each bucket in PK-sorted order
and every `addEntry` *appends* to the sorted array (insertion point = end → no
splice shift). Measured single-bucket build, ascending order: ~6/2/9/12 ms at
N = 10k/20k/40k/80k — flat/linear, **no cliff**.

**2. The O(N²) cliff is real but only for OUT-OF-ORDER PK arrival** into a
low-cardinality bucket (scattered/UUID PKs, `insert … select` with non-monotonic
keys, delete+reinsert churn). Measured single-bucket build:

| N      | ascending | descending | shuffled |
|--------|-----------|------------|----------|
| 10k    | 5.9 ms    | 11.6 ms    | 5.7 ms   |
| 20k    | 2.1 ms    | 31.4 ms    | 22.6 ms  |
| 40k    | 8.8 ms    | 179.9 ms   | 61.2 ms  |
| 80k    | 11.9 ms   | 454.7 ms   | 351.0 ms |
| 250k   | —         | **4369 ms**| —        |

Descending/shuffled scale ~O(N²) (≈15× per 4× size). 250k descending = **4369 ms**.

**3. An SQL-level sentinel is a poor instrument here.** The SQL pipeline's linear
per-row overhead dominates and masks the container's quadratic term: full
SQL-path descending build measured 477 / 1192 / 3306 ms at N = 20k/50k/100k —
only ~22 % of the 100k figure is the container. A meaningful sentinel must
measure the container directly (see snippet).

**4. The COW path is inherently O(M) per cross-layer touch, regardless of
container** — `structuredClone` deep-copies the whole bucket every time a leaf
holding it is first written in a layer. A sub-linear container therefore only
helps the *in-layer (owned)* ops *after* the first COW touch; it cannot make the
cross-layer touch sub-O(M). The achievable win is real (turns an owned
out-of-order build of O(M²) into O(M log M)/O(M√M)), but narrower than "restore
sub-linear PK add/remove" implies.

---

## Alternatives for sign-off

Hard constraint for all: `primaryKeys` must be **structured-cloneable plain data
with no prototype-dependence** (Array / Map / Set / typed arrays / nested plain
objects — no class instances, no functions).

**A. Do nothing (accept the status quo).** Build/consolidation are O(N); only
out-of-order DML into very large low-cardinality buckets degrades to O(M²).
Cheapest; just document the bound. Reasonable if such workloads (millions of
rows, single index value, scattered PKs, all in one logical build) are out of
scope. Quereus is in-memory, so the absolute cost is modest until very large M.

**B. Structured-cloneable balanced search structure, comparator passed in.**
A plain-data B-tree, or simpler **sqrt-decomposition** (array of sorted chunks):
search picks a chunk by binary-searching chunk maxima then binary-searches within
it; insert splices into a chunk (O(√M)) and splits when a chunk doubles. All
arrays → structured-cloneable. Preserves PK-sorted iteration for free. Owned ops
O(√M) (≈M^1.5 build, est. ~125 ms at 250k) or O(log M) for a full B-tree.
Cost: bespoke data-structure code in the MVCC hot path — needs careful COW /
rollback / multi-entry-leaf tests. COW touch stays O(M) (structuredClone).

**C. `Map` keyed by a type-aware LOSSLESS PK encoding + sort-on-read.**
`Map` survives `structuredClone` (round-trips as a Map). Owned add/remove/dedup
become O(1). Requires (i) a lossless encoder that normalizes representations
(`5n`/`5` → same key) and recurses composite arrays / encodes blobs, and (ii)
sorting the bucket on each scan to preserve the current PK-sorted scan output
order (or caching a sorted snapshot invalidated on mutation). Build O(M); scans
pay O(M log M) per bucket.

  The original ticket rejected canonical-key maps as "collation-incorrect."
  **Re-examined, that rejection is over-conservative given the primary tree's
  PK-uniqueness invariant.** Every PK that can coexist is pairwise *distinct under
  the PK comparator*, so dedup only ever needs to catch (a) re-adds of the
  *identical* value and (b) cross-representation equals (`5n`/`5`). A *lossless*
  encoder (NOT a collation transform) never false-merges two collation-distinct
  PKs; and two collation-EQUAL-but-raw-distinct values (e.g. NOCASE `'A'`/`'a'`,
  or a custom-collation `'café'`/`'cafe'`) can never both be PKs, so they never
  need to dedup against each other. Removes always use the actual stored row's PK,
  so the encoding round-trips. → A lossless-encoding Map is value-correct.

  Open questions for sign-off: the codebase deliberately used a `BTree` (not a
  string key) for scan-layer's dedup `seen` set — is introducing a PK value
  encoder acceptable? Is the per-scan sort cost (or a cached sorted snapshot)
  acceptable? Does anything depend on PK-sorted scan order beyond current tests?

**Recommendation:** B (sqrt-decomposition) or C, but the choice — and whether the
narrowed win justifies bespoke structure in the MVCC core — is the human's call.
Per AGENTS.md ("brainstorm with the dev for another way" rather than hand-roll
janky structures into the core), this is parked for sign-off.

---

## Ready-to-use sentinel (drop into performance-sentinels.spec.ts once a design is chosen)

Container-level, descending order, to dodge SQL-pipeline noise (finding #3). The
unmodified sorted array fails this (~4369 ms); any sub-linear cloneable container
passes well under 2 s.

```ts
// imports: MemoryIndex (src/vtab/memory/index.js),
// createPrimaryKeyFunctions (src/vtab/memory/utils/primary-key.js),
// createDefaultColumnSchema (src/schema/column.js), INTEGER_TYPE (src/types/builtin-types.js)
describe('Secondary index per-entry PK container', function () {
  this.timeout(120_000);
  it('builds a single-key bucket of 250k out-of-order PKs under 2 s', () => {
    const columns = [
      { ...createDefaultColumnSchema('status'), logicalType: INTEGER_TYPE },
      { ...createDefaultColumnSchema('id'), logicalType: INTEGER_TYPE },
    ];
    const pkCompare = createPrimaryKeyFunctions({
      name: 'orders', schemaName: 'main', columns,
      columnIndexMap: new Map(columns.map((c, i) => [c.name.toLowerCase(), i])),
      primaryKeyDefinition: [{ index: 1 }], checkConstraints: [],
      vtabModuleName: 'memory', isView: false,
    } as any).compare;
    const index = new MemoryIndex({ name: 'ix_status', columns: [{ index: 0 }] }, columns, pkCompare);
    const N = 250_000;
    const start = performance.now();
    for (let pk = N; pk >= 1; pk--) index.addEntry(0, pk); // descending => array-front splice worst case
    const elapsed = performance.now() - start;
    expect(index.getPrimaryKeys(0)).to.have.length(N);
    expect(elapsed).to.be.below(2000, `250k out-of-order PK adds took ${elapsed.toFixed(1)} ms`);
  });
});
```

## Required test coverage for whatever container lands

The existing value-identity suite uses single-entry trees and **masks COW
corruption**. Any new container MUST add a **multi-entry-leaf COW** test: build a
`base` index with ≥2 distinct index keys, create a child inheriting `base.data`,
COW one entry on the child, then assert a *sibling* entry still serves its PKs
through the child AND that `base` is unchanged. (Plus the in-place/promotion,
value-identity-in-both-modes, consolidation-survival cases from the original
spec, adapted to the chosen structure.)

---

## Original spec (preserved verbatim — DO NOT resume unchanged; see blocker above)

> # MemoryIndex per-entry PK container: lazy array → BTree promotion
>
> ## Problem (recap)
>
> `MemoryIndexEntry.primaryKeys` is a `BTreeKeyForPrimary[]` kept sorted under the
> table's PK comparator, with add/remove done by binary-search + `splice`. Search
> is `O(log n)` but the splice is `O(n)` in the number of PKs already under that
> index key. For a **non-unique** secondary index whose index key has low
> cardinality (e.g. `create index ix_status on orders(status)` over millions of
> rows with a handful of distinct statuses), one entry's array grows to `M`
> members and the `M` inserts cost `O(M^2)` to build that bucket — `O(N^2)`
> overall in the degenerate single-key case. Bulk build (`base.ts`) and
> steady-state DML (`transaction.ts`) both pay it. The dominant unique/near-unique
> case (`n ≈ 1`) is unaffected — splice is effectively `O(1)`.
>
> The prior JS `Set` was `O(1)` per op but value-incorrect for composite/array PKs
> and across scalar representations (`5n` vs `5`) — that is the correctness reason
> the sorted array replaced it (see `memory-index-composite-pk-value-identity`,
> complete). We must keep value-identity while restoring sub-linear ops.
>
> ## Decision: lazy array → BTree promotion (one-way)
>
> Introduce a per-entry container, `PrimaryKeySet`, holding **either**:
>
> - a sorted `BTreeKeyForPrimary[]` (the start state, optimal for the dominant
>   one-/few-PK bucket), or
> - an `inheritree` `BTree<BTreeKeyForPrimary, BTreeKeyForPrimary>` keyed by
>   identity (`pk => pk`) under the table's PK comparator, once the member count
>   crosses `PROMOTE_THRESHOLD`.
>
> Promotion is **one-way** (no demotion). A bucket that grows large then shrinks
> keeps its BTree: ops stay `O(log n)` and we avoid threshold flapping / hysteresis
> at the boundary. The slightly higher steady memory for a shrunk-then-stable
> bucket is an accepted tradeoff.
>
> `PROMOTE_THRESHOLD` is a tuning knob, **not** correctness-relevant. Default to a
> small power of two above one BTree leaf (`inheritree` `NodeCapacity` is 64) — use
> `256`. Export it (e.g. `export const PRIMARY_KEY_SET_PROMOTE_THRESHOLD = 256`) so
> tests can derive `threshold + 1` without hard-coding.
>
> Both modes iterate in **PK-sorted order**, so scan output ordering under a single
> index key is identical before/after promotion (no behavioral change to
> `scan-layer`).
>
> ### Why not the alternatives
>
> - **Canonical-string `Map` per entry** — rejected by the original ticket and
>   still rejected: a general custom collation exposes only `compare`, with no
>   canonical byte form, so an `O(1)` string-keyed map can't be made
>   collation-correct.   [SEE ALT C ABOVE: this rejection is over-conservative.]
> - **Always-BTree per entry** — a BTree per entry is heavier than an array for the
>   dominant one-PK bucket; the array start + lazy promotion keeps that path cheap.
>
> ### Why this is COW- and collapse-safe (verified)   [FALSE — see "Root cause" above]
>
> - **COW clone** (an inherited entry mutated by a child layer): array mode clones
>   via `slice()` (unchanged); tree mode clones via base-inheritance —
>   `new BTree(keyFromEntry, compare, inheritedTree)` — which is `O(1)`-ish and
>   gives `inheritree`'s node-level copy-on-write, so the ancestor's tree is never
>   written through. This mirrors the existing array-`slice` discipline exactly.
>   [WRONG: the OUTER tree structuredClones the entry — including a nested BTree —
>   on its own node COW. DataCloneError. The "verified" claim never checked
>   inheritree's LeafNode.clone implementation.]
> - **`clearBase()` / consolidation / freeze** notes — unaffected by the blocker,
>   but moot until a cloneable container is chosen.
>
> ## Container interface (`primary-key-set.ts`)   [class instance is itself the problem]
>
> The comparator stays on `MemoryIndex` (per-index, identical for every entry — do
> not store a copy in every container as data). Pass it into the ops that need it.
> Sketch: `singleton/add/remove/has/size/isEmpty/clone/[Symbol.iterator]/toArray`,
> explicit `size` counter (do NOT call `inheritree`'s `getCount()` on the hot path),
> in-place one-way promotion building the tree from the sorted array.
>
> ## Wiring into `MemoryIndex` (`index.ts`)
>
> - `MemoryIndexEntry.primaryKeys` becomes `PrimaryKeySet`; delegate
>   `addEntry`/`removeEntry`/`getPrimaryKeys` onto the container; keep the
>   `ownedEntries` COW shape; owned → in-place `add`/`remove` (never reassign
>   `entry.primaryKeys`), inherited → `clone` then mutate then `updateAt`, absent →
>   `singleton`; emptied → `deleteAt`.
> - Optional `hasAnyPrimaryKey(indexKey)` emptiness probe for `populateNewIndex`.
>
> ## Edge cases & interactions
>
> Dominant one-PK path stays array mode; promotion boundary at `threshold`/`+1`;
> value identity in BOTH modes (composite/array dedup, `5n`/`5`); COW isolation in
> array AND tree mode; COW + promotion crossing during clone; emptying a tree-backed
> entry; in-place promotion never reassigns `entry.primaryKeys`; layer collapse
> (`clearBase`) with tree-backed inherited entries; consolidation on commit;
> UNIQUE-index path; PK-sorted iteration; deep base-chain growth (bounded by layer
> depth, flattened on consolidation); partial-index predicate add/remove.
>
> ## Decision gate (profile first)
>
> [DONE this run: cliff CONFIRMED for out-of-order arrival (250k descending =
> 4369 ms), but build/consolidation are already O(N) append. The redesign is
> blocked not by the gate but by the structuredClone infeasibility above.]
