description: A MemoryIndex entry's `primaryKeys` is a sorted `BTreeKeyForPrimary[]` with O(n) binary-search + splice per add/remove. For a low-cardinality NON-UNIQUE secondary index (few distinct index keys, many PKs sharing each key), inserting M rows under one index key is O(M²) — the per-entry array grows to length M and each insert splices into it. The prior JS `Set` was O(1) per op but value-incorrect for composite PKs (the reason it was replaced). This ticket tracks restoring sub-linear per-entry add/remove without regressing value-identity correctness.
prereq:
files:
  - packages/quereus/src/vtab/memory/index.ts        # findPrimaryKeyPosition / insertPrimaryKey / removePrimaryKey (O(n) splice); addEntry/removeEntry
  - packages/quereus/src/vtab/memory/types.ts         # MemoryIndexEntry.primaryKeys: BTreeKeyForPrimary[]
  - packages/quereus/src/vtab/memory/layer/base.ts    # populateNewIndex / addRowToSecondaryIndexes (bulk build path that feels O(N²))
difficulty: medium
----

# MemoryIndex secondary-entry PK set: O(n) splice → O(N²) build for low-cardinality non-unique indexes

## Background

`memory-index-composite-pk-value-identity` (complete) replaced
`MemoryIndexEntry.primaryKeys` from a JS `Set<BTreeKeyForPrimary>` to a
`BTreeKeyForPrimary[]` kept sorted under the table's PK comparator, with
add/remove/contains done by binary search. This was a **correctness** fix: a
`Set` keys members by SameValueZero/reference identity, so a composite (array)
PK — freshly allocated on each extraction — could never be removed by value and
stored equal-by-value duplicates; even scalar integer PKs diverged across
`5n`/`5`. The sorted array compares by *value* and is correct.

The cost: each `addEntry`/`removeEntry` is `O(log n)` search + `O(n)` array
splice, where `n` is the number of PKs already under that index key. A `Set`
was `O(1)` amortized.

## The scalability concern

For a **non-unique** secondary index whose index key has low cardinality (few
distinct values over many rows — e.g. `create index ix_status on orders(status)`
where `status` has a handful of values over millions of rows), one entry's
`primaryKeys` array grows to `M` members and each of the `M` inserts splices
into it: `O(M²)` to build that key's bucket, `O(N²)` overall in the degenerate
single-key case. Bulk index build (`base.ts: populateNewIndex` /
`addRowToSecondaryIndexes`) and steady-state DML both pay this.

This is not purely pathological — it is the natural shape of an index on a
status/flag/category column over a large table.

The common case (unique or near-unique index → one PK per entry) is unaffected:
`n` ≈ 1, so search + splice are effectively O(1).

## Expected behavior / direction

Restore sub-linear per-entry add/remove **without** regressing the value-identity
correctness or the inherited-entry copy-on-write discipline (a TransactionLayer
clones an inherited entry's container before mutating, so the committed base is
never written through — see `MemoryIndex.ownedEntries`). Candidate approaches to
weigh:

- **Per-entry BTree** keyed by the PK comparator (the escalation the original
  ticket documented). Restores `O(log n)` add/remove/contains. Cost: a BTree per
  entry is heavier than an array for the dominant one-PK-per-entry case, so it
  may want to be lazy (array until the bucket exceeds a threshold, then promote).
  COW clone becomes a BTree base-inherit instead of `slice()`.
- **Canonical-key map per entry** (`Map<canonicalString, PK>`): O(1) add/remove,
  but requires a representation- *and* collation-canonical serialization of a PK
  under the table's PK collation — including custom collations that expose only a
  `compare`. The original ticket rejected a canonical-string map for exactly this
  reason (a general custom collation has no canonical byte form); only revisit if
  a comparator-derived canonical encoding is provably available.

## Acceptance

- A benchmark (or `performance-sentinels.spec.ts` case) demonstrating the
  low-cardinality non-unique build cost, and a measured improvement after the
  change.
- All existing memory-index correctness tests still pass, including
  `test/vtab/memory-index-pk-value-identity.spec.ts` (value identity + inherited
  copy-on-write isolation).
- No regression to the one-PK-per-entry dominant path.

## Note

Speculative until profiled — file is a tracked follow-up, not a confirmed
regression in any current workload. Profile first to confirm the cliff is hit in
practice before committing to the per-entry container redesign.
