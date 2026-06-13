description: Restore sub-linear per-entry PK add/remove for low-cardinality non-unique secondary indexes by giving each MemoryIndexEntry a lazy container — a sorted array that promotes to an inheritree BTree once its PK count crosses a threshold — without regressing value-identity correctness, the one-PK-per-entry fast path, or the inherited copy-on-write discipline.
prereq:
files:
  - packages/quereus/src/vtab/memory/index.ts                      # MemoryIndex: addEntry/removeEntry/getPrimaryKeys + COW (ownedEntries); replace inline array splice with container ops
  - packages/quereus/src/vtab/memory/types.ts                      # MemoryIndexEntry.primaryKeys: change BTreeKeyForPrimary[] -> PrimaryKeySet
  - packages/quereus/src/vtab/memory/primary-key-set.ts            # NEW: the lazy array->BTree container
  - packages/quereus/src/vtab/memory/layer/scan-layer.ts           # `for (const pk of indexEntry.primaryKeys)` — works unchanged if container is iterable; verify
  - packages/quereus/src/vtab/memory/layer/base.ts                 # populateNewIndex / addRowToSecondaryIndexes — bulk build path that pays the O(N^2)
  - packages/quereus/src/vtab/memory/layer/transaction.ts          # recordUpsert add/removeEntry path (steady-state DML)
  - packages/quereus/src/vtab/memory/utils/primary-key.ts          # createPrimaryKeyFunctions().compare — the comparator threaded into MemoryIndex
  - packages/quereus/test/vtab/memory-index-pk-value-identity.spec.ts   # extend with tree-backed + promotion + COW-in-tree-mode cases
  - packages/quereus/test/performance-sentinels.spec.ts            # add the low-cardinality non-unique build sentinel
difficulty: medium
----

# MemoryIndex per-entry PK container: lazy array → BTree promotion

## Problem (recap)

`MemoryIndexEntry.primaryKeys` is a `BTreeKeyForPrimary[]` kept sorted under the
table's PK comparator, with add/remove done by binary-search + `splice`. Search
is `O(log n)` but the splice is `O(n)` in the number of PKs already under that
index key. For a **non-unique** secondary index whose index key has low
cardinality (e.g. `create index ix_status on orders(status)` over millions of
rows with a handful of distinct statuses), one entry's array grows to `M`
members and the `M` inserts cost `O(M^2)` to build that bucket — `O(N^2)`
overall in the degenerate single-key case. Bulk build (`base.ts`) and
steady-state DML (`transaction.ts`) both pay it. The dominant unique/near-unique
case (`n ≈ 1`) is unaffected — splice is effectively `O(1)`.

The prior JS `Set` was `O(1)` per op but value-incorrect for composite/array PKs
and across scalar representations (`5n` vs `5`) — that is the correctness reason
the sorted array replaced it (see `memory-index-composite-pk-value-identity`,
complete). We must keep value-identity while restoring sub-linear ops.

## Decision: lazy array → BTree promotion (one-way)

Introduce a per-entry container, `PrimaryKeySet`, holding **either**:

- a sorted `BTreeKeyForPrimary[]` (the start state, optimal for the dominant
  one-/few-PK bucket), or
- an `inheritree` `BTree<BTreeKeyForPrimary, BTreeKeyForPrimary>` keyed by
  identity (`pk => pk`) under the table's PK comparator, once the member count
  crosses `PROMOTE_THRESHOLD`.

Promotion is **one-way** (no demotion). A bucket that grows large then shrinks
keeps its BTree: ops stay `O(log n)` and we avoid threshold flapping / hysteresis
at the boundary. The slightly higher steady memory for a shrunk-then-stable
bucket is an accepted tradeoff.

`PROMOTE_THRESHOLD` is a tuning knob, **not** correctness-relevant. Default to a
small power of two above one BTree leaf (`inheritree` `NodeCapacity` is 64) — use
`256`. Export it (e.g. `export const PRIMARY_KEY_SET_PROMOTE_THRESHOLD = 256`) so
tests can derive `threshold + 1` without hard-coding.

Both modes iterate in **PK-sorted order**, so scan output ordering under a single
index key is identical before/after promotion (no behavioral change to
`scan-layer`).

### Why not the alternatives

- **Canonical-string `Map` per entry** — rejected by the original ticket and
  still rejected: a general custom collation exposes only `compare`, with no
  canonical byte form, so an `O(1)` string-keyed map can't be made
  collation-correct.
- **Always-BTree per entry** — a BTree per entry is heavier than an array for the
  dominant one-PK bucket; the array start + lazy promotion keeps that path cheap.

### Why this is COW- and collapse-safe (verified)

- **COW clone** (an inherited entry mutated by a child layer): array mode clones
  via `slice()` (unchanged); tree mode clones via base-inheritance —
  `new BTree(keyFromEntry, compare, inheritedTree)` — which is `O(1)`-ish and
  gives `inheritree`'s node-level copy-on-write, so the ancestor's tree is never
  written through. This mirrors the existing array-`slice` discipline exactly.
- **`clearBase()` (layer collapse / promote-to-independent,
  `manager.tryCollapseLayers`)** detaches only the *outer* secondary-index tree
  from its base. Inherited entry objects (and their per-entry trees) remain valid
  via object references; per-entry tree base-chains do **not** need flattening
  here.
- **Consolidation (commit, `manager.copyTransactionDataToBase` →
  `base.rebuildPrimaryTreeFromRows`)** rebuilds every secondary index from
  scratch, so per-entry tree base-chains are discarded and rebuilt on commit —
  no chain survives a consolidation.
- **`inheritree` freezes inserted entries shallowly.** Today's owned-entry fast
  path already mutates `entry.primaryKeys` *contents* in place under a frozen
  `MemoryIndexEntry`. The container must preserve this: `add`/`remove` and the
  in-place promotion swap (`array → tree`) mutate the *same* `PrimaryKeySet`
  object's internal fields and must **never reassign** `entry.primaryKeys`. COW
  (inherited) entries instead build a *new* entry object wrapping a *cloned*
  container, then `insert`/`updateAt` (which freezes the new entry) — unchanged.

## Container interface (`primary-key-set.ts`)

The comparator stays on `MemoryIndex` (per-index, identical for every entry — do
not store a copy in every container as data). Pass it into the ops that need it;
the tree-mode container holds a `BTree` that references the shared comparator
function (a single shared function reference, not duplicated data — acceptable).

Sketch (adjust naming to match surrounding code; keep functions small and
single-purpose per AGENTS.md):

```ts
export const PRIMARY_KEY_SET_PROMOTE_THRESHOLD = 256;

export class PrimaryKeySet implements Iterable<BTreeKeyForPrimary> {
  // exactly one of these is active; `tree` non-null ⇒ promoted
  private arr: BTreeKeyForPrimary[] | null;
  private tree: BTree<BTreeKeyForPrimary, BTreeKeyForPrimary> | null;

  static singleton(pk): PrimaryKeySet;            // owned new entry: one PK, array mode
  add(pk, compare): boolean;                      // dedup by value; promotes in place at threshold; returns true if added
  remove(pk, compare): boolean;                   // by value; returns true if present (one-way: no demotion)
  has(pk, compare): boolean;
  get size(): number;                             // O(1): maintain an explicit count
  get isEmpty(): boolean;
  clone(compare): PrimaryKeySet;                  // COW: array -> slice; tree -> base-inherit
  [Symbol.iterator](): Iterator<BTreeKeyForPrimary>;   // PK-sorted in BOTH modes
  toArray(): BTreeKeyForPrimary[];                // for getPrimaryKeys()'s defensive copy
}
```

Notes:
- Maintain an explicit `size` counter — do **not** call `inheritree`'s
  `getCount()` (which is `O(n/fill)`) on the hot path.
- In-place promotion: build the tree from the sorted array (one `O(T log T)`
  pass), null out `arr`, set `tree`; this is the only allocation spike and it
  happens once per bucket.
- `clone(compare)` for tree mode: `new BTree(pk => pk, compare, this.tree)` — the
  clone's count starts equal to `this.size`; carry it over.

## Wiring into `MemoryIndex` (`index.ts`)

- `MemoryIndexEntry.primaryKeys` becomes `PrimaryKeySet` (types.ts). Update its
  doc comment to describe the lazy container (keep the value-identity rationale).
- Replace `insertPrimaryKey` / `removePrimaryKey` / `findPrimaryKeyPosition`
  array helpers with delegations to the container's `add` / `remove` (the binary
  search now lives in the array-mode container).
- `addEntry`:
  - owned existing entry → `entry.primaryKeys.add(pk, this.primaryKeyComparator)`
    (in place; may self-promote).
  - inherited existing entry → `const c = existing.primaryKeys.clone(cmp);
    c.add(pk, cmp);` build new entry `{ indexKey: existing.indexKey, primaryKeys: c }`,
    add to `ownedEntries`, `updateAt`.
  - absent → `PrimaryKeySet.singleton(pk)`, new entry, `ownedEntries.add`, `insert`.
- `removeEntry`:
  - owned → `entry.primaryKeys.remove(...)`; if `isEmpty` → `deleteAt`.
  - inherited → `clone`, `remove`; if `isEmpty` → `deleteAt` (mask) else new
    owned entry + `updateAt`.
- `getPrimaryKeys(indexKey)` → `entry ? entry.primaryKeys.toArray() : []`.
- `scan-layer.ts`: `for (const pk of indexEntry.primaryKeys)` works unchanged
  once `PrimaryKeySet` is `Iterable`; confirm both scan branches compile and
  iterate correctly.
- Optional micro-opt (note, don't gold-plate): `base.populateNewIndex` and any
  emptiness probe use `getPrimaryKeys(indexKey).length > 0`, which materializes a
  full array just to test non-emptiness. Add `MemoryIndex.hasAnyPrimaryKey(indexKey)`
  (delegating to `!isEmpty`) and use it there. UNIQUE indexes are near-unique
  (`n ≈ 1`) so the array copy is cheap in practice — apply only if trivial.

## Decision gate (profile first — per source ticket's "Note")

The source ticket flags this as speculative-until-profiled. Phase 1 below writes
the sentinel and runs it against the **unmodified** code to capture the baseline.

- If the baseline confirms the cliff (build time scales super-linearly / blows
  the generous threshold for a low-cardinality non-unique index at the chosen
  `N`), proceed with the container change.
- If, at a realistic `N` (use `N` in the tens of thousands so the sentinel stays
  well under the 10-minute idle window), the baseline does **not** show a cliff,
  do **not** ship the container redesign: instead update this ticket with the
  measurements and move it to `blocked/` for human sign-off (design question:
  "is the redesign warranted?"). Reasoned expectation is that `O(M^2)` array
  splice *will* show the cliff at `N ≈ 20k`, single distinct key — so the
  redesign is expected to proceed, but capture the numbers either way.

## Edge cases & interactions

- **Dominant one-PK-per-entry path**: stays array mode, zero BTree allocation.
  Guard with existing sentinels (`bulk insert 1000 rows`, `index lookup after
  bulk insert`) — no regression.
- **Promotion boundary**: insert exactly `threshold` then `threshold + 1` PKs —
  the crossing insert promotes, all prior members migrate in sorted order, no
  loss/dup; `size` correct across the swap.
- **Value identity in BOTH modes**: composite/array PK dedup on add and
  remove-by-value (fresh equal-by-value array), and scalar `5n`/`5` dedup —
  assert in array mode AND after forcing promotion (push `> threshold` PKs).
- **COW isolation, array mode** (existing tests): inherited add of a distinct PK,
  inherited remove that empties, inherited add of a present PK — base untouched.
- **COW isolation, tree mode** (NEW): seed a `base` index with `> threshold`
  distinct PKs under one index key (forces promotion), create a child inheriting
  `base.data`, then on the child: add a distinct PK, remove-by-value to empty,
  re-add a present PK — child reflects the change, `base.getPrimaryKeys(...)`
  unchanged (base-inherit COW does not write through).
- **COW + promotion crossing during clone**: inherited array entry sitting at
  `threshold`; child `add` crosses the boundary → child's clone promotes, base
  stays array and untouched.
- **Emptying a tree-backed entry**: `removeEntry` that drains a promoted entry
  deletes the tree-entry from `this.data` (keeps distinct-key stats accurate);
  child masking of an inherited tree-backed entry leaves base intact.
- **In-place promotion never reassigns `entry.primaryKeys`** (frozen entry) — add
  a test that mutates an owned entry past the threshold and confirms the same
  `MemoryIndexEntry` object is still in the tree and serves the right PKs.
- **Layer collapse (`clearBase`)** with tree-backed inherited entries: after
  `tryCollapseLayers` promotes a layer, the promoted layer still serves correct
  PKs for a high-multiplicity bucket and a subsequent child COW still isolates.
- **Consolidation on commit**: a committed high-multiplicity bucket survives
  `commit` (which rebuilds secondaries via `rebuildPrimaryTreeFromRows`) with
  exact membership — assert count + a sampled member after commit.
- **UNIQUE index path**: `indexEnforcesUnique` build still rejects duplicate keys
  correctly; emptiness probe correct for a (rare) promoted UNIQUE entry.
- **Iteration order**: scan under one index key yields PK-sorted in both modes —
  no change to query results.
- **Deep base-chain growth** across nested savepoints for one hot bucket: bounded
  by active layer depth and flattened on consolidation. Note as a known bound;
  do not add chain-compaction machinery in this ticket.
- **Partial-index predicate** add/remove (`transaction.recordUpsert` in/out of
  scope) is exercised by existing tests; confirm still green.

## TODO

Phase 1 — Sentinel + baseline (decision gate)
- Add a `performance-sentinels.spec.ts` case: create a table with `N ≈ 20_000`
  rows and a non-unique index on a column with a single (or ~3) distinct
  value(s); time the index population / bulk insert. Stream any long output per
  AGENTS.md (`... | tee` then read the tail) — but this should be fast.
- Run it against unmodified code; record the baseline number. If no cliff at
  realistic `N`, STOP and route to `blocked/` per the decision gate above.

Phase 2 — Container
- Implement `primary-key-set.ts` (`PrimaryKeySet`, `PRIMARY_KEY_SET_PROMOTE_THRESHOLD`)
  with array start, in-place one-way promotion, sorted iteration in both modes,
  `clone` (slice / base-inherit), explicit `size`, `isEmpty`, `toArray`.

Phase 3 — Wire-in
- Change `MemoryIndexEntry.primaryKeys` to `PrimaryKeySet` (types.ts, update doc).
- Refactor `MemoryIndex.addEntry`/`removeEntry`/`getPrimaryKeys` onto the
  container; drop the inline array helpers; keep the `ownedEntries` COW shape.
- Confirm `scan-layer.ts` iteration compiles/runs (container is `Iterable`).
- Optional `hasAnyPrimaryKey` emptiness probe for `base.populateNewIndex` if trivial.

Phase 4 — Tests + validate
- Extend `memory-index-pk-value-identity.spec.ts` with a tree-mode `describe`
  (promotion, value-identity in tree mode, COW-in-tree-mode, COW+promotion
  crossing, in-place-promotion-no-reassign, consolidation survival).
- Confirm the Phase-1 sentinel now passes comfortably (measured improvement);
  keep both numbers in the review handoff.
- Run `yarn workspace @quereus/quereus test` (memory-backed) and the lint script;
  fix anything in-diff. Document any genuinely pre-existing, unrelated failure
  per `tickets/.pre-existing-error.md` rather than chasing it.
