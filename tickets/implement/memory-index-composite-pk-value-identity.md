description: MemoryIndexEntry.primaryKeys is a JS Set keyed by reference/SameValueZero identity. Composite primary keys are arrays (fresh per extraction) so removeEntry can never drop one by value, and addEntry can store equal-by-value duplicates; integer keys can also vary representation (bigint vs number) and cross the build-vs-extract path divergence. Replace the Set with a value-set keyed by the table's PK comparator (collation- and representation-aware) for add/remove/iterate, preserving the inherited-entry copy-on-write discipline.
prereq:
files:
  - packages/quereus/src/vtab/memory/types.ts             # MemoryIndexEntry.primaryKeys type
  - packages/quereus/src/vtab/memory/index.ts             # MemoryIndex add/removeEntry, getPrimaryKeys, ownedEntries COW; needs PK comparator
  - packages/quereus/src/vtab/memory/layer/base.ts        # 3x `new MemoryIndex(indexSchema, this.tableSchema.columns)` call sites
  - packages/quereus/src/vtab/memory/layer/transaction.ts # 1x `new MemoryIndex(...)` call site; recordUpsert/recordDelete drive add/removeEntry
  - packages/quereus/src/vtab/memory/layer/scan-layer.ts  # iterates `entry.primaryKeys` (2 sites) — array-compatible, expected unchanged
  - packages/quereus/src/vtab/memory/utils/primary-key.ts # createPrimaryKeyFunctions(schema).compare — the comparator to thread in
  - packages/quereus/test/vtab/                           # add the regression spec here (see TODO)
difficulty: medium
----

# Fix: memory secondary-index entries must track primary keys by value, not JS identity

## Root cause (confirmed)

`MemoryIndexEntry.primaryKeys` is `Set<BTreeKeyForPrimary>`. A `Set` keys members
by SameValueZero/reference identity:

- **Composite PK (array)** — every PK extraction builds a *fresh* array
  (`createPrimaryKeyFunctions.extractFromRow`, `buildPrimaryKeyFromValues`). So
  `Set.delete(pkArray)` in `MemoryIndex.removeEntry` compares a fresh array
  against the stored one by reference and **never removes**; `Set.add(pkArray)`
  likewise stores **equal-by-value duplicates**.
- **Single-column integer PK** — mostly works by value, except across
  representations (`compareSqlValues` treats `5n ≡ 5`; `Set` does not) and across
  the build-vs-extract path divergence (see below).

Reproduced at the `MemoryIndex` unit level: `addEntry(1, [10,20])` then
`removeEntry(1, [10,20])` (fresh equal array) leaves `getPrimaryKeys(1).length === 1`
(expected `0`); a second `addEntry(5, [10,20])` yields length `2` (expected `1`).

### Why collation-awareness is genuinely required (not just representation)

It is tempting to "fix" this with a `Map<canonicalString, pk>` keyed by a
representation-normalized, type-tagged canonical key (à la `canonKeyValues` in
`database-materialized-views.ts`). **That is insufficient** for collation-aware
PKs, because the PK passed to `addEntry` vs `removeEntry` can be *byte-different
but comparator-equal*:

- On INSERT, `transaction.recordUpsert` stores the member as
  `primaryKeyFromRow(storedRow)` → the **stored** bytes (e.g. `'A'` for a
  `NOCASE` text PK column).
- On DELETE, `manager.performDelete` builds
  `buildPrimaryKeyFromValues(oldKeyValues, …)` from the **user-supplied** key
  values (e.g. `delete … where a='a'` → `'a'`) and passes *that* to
  `recordDelete` → `removeEntry`.

A byte/representation-canonical map keyed on `'a'` would miss the stored `'A'`; a
`NOCASE`-correct comparator matches them. A general custom collation provides
only a `compare` function (no canonical-form), so **only a comparator-backed
structure is correct in general.** (PK-tree uniqueness guarantees the live PKs in
one index entry are pairwise distinct under the comparator, so there is no
ambiguity about which member a value-equal remove targets.)

## Fix: comparator-keyed value-set for `primaryKeys`

Replace the identity `Set` with a value-set ordered by the **table's PK
comparator** (`createPrimaryKeyFunctions(schema).compare`). Recommended shape: a
**sorted `BTreeKeyForPrimary[]` with binary-search insert/remove/contains** under
the PK comparator, owned by `MemoryIndex` (the comparator is per-index, identical
for every entry, so store it on the index — do **not** duplicate it per entry).

- `addEntry`: binary-search; insert at position only if not already present
  (value dedup). For an **inherited** entry, clone the array (`slice()`) before
  mutating, exactly mirroring the current `new Set(existing)` copy-on-write —
  preserving the `ownedEntries` discipline documented on `MemoryIndex.ownedEntries`
  (mutating an inherited entry's container writes through to the ancestor layer and
  corrupts committed state on rollback).
- `removeEntry`: binary-search; remove if present; if the array is now empty,
  `deleteAt` the whole entry (owned) or `updateAt`/`deleteAt` (inherited clone) —
  same branch structure as today.
- `getPrimaryKeys`: return a defensive copy (`entry.primaryKeys.slice()`).
- `scan-layer.ts` iterates `for (const pk of entry.primaryKeys)` — an array
  satisfies this unchanged; verify no other consumer relied on `Set` methods.

Why sorted-array over alternatives:

- vs **identity `Set`** — the bug.
- vs **canonical-string `Map`** — incorrect for collation-aware PKs (above).
- vs **inheritree `BTree` per entry** — fully correct and gives node-level COW via
  base-inheritance, but allocates a BTree per *distinct index-key value*; the
  dominant entry holds a single PK, so this is heavyweight. Keep the BTree-per-entry
  in your back pocket only if profiling a pathological low-cardinality non-unique
  index (few distinct index keys, many PKs each) shows the array's O(n) splice
  hurts. Document the choice either way.

### Threading the comparator

Every `new MemoryIndex(...)` call site has the full `TableSchema` in scope
(`this.tableSchema` in `base.ts`; `this.tableSchemaAtCreation`/`schema` in
`transaction.ts`), so it can pass `createPrimaryKeyFunctions(schema).compare`.
Add a `primaryKeyComparator: (a: BTreeKeyForPrimary, b: BTreeKeyForPrimary) => number`
parameter to the `MemoryIndex` constructor and update all four sites:

- `base.ts`: `createSecondaryIndexes`, `rebuildAllSecondaryIndexesStrict`, `addIndexToBase`
- `transaction.ts`: `initializeSecondaryIndexes`

Cross-layer consistency: all layers of a table derive the comparator from the same
PK definition, so an inherited (sorted) array stays correctly ordered for the
child layer's binary search. A PK-collation change via `ALTER COLUMN … SET COLLATE`
triggers a full base rebuild (`rebuildAllSecondaryIndexes` / `rebuildPrimaryTreeStrict`),
recreating entries under the new comparator — so no stale sort order survives an
ALTER. Note this in a comment.

## Consequences this resolves

- **removeEntry actually removes** composite PKs → no stale-PK accumulation in
  secondary-index entries on UPDATE-of-indexed-column / DELETE.
- **Phantom index-scan rows** (`scan-layer.ts` yields `primaryTree.get(pk)` for a
  stale PK whose row was updated-in-place to a non-matching index value) disappear,
  because the stale PK is gone from the entry.
- **Inflated index stats**: emptied entries are now deleted, so
  `getBaseLayerStats`' `idxTree.getCount()` (distinct index keys) is accurate
  again — no code change there, fixed transitively. Confirm.
- **UNIQUE enforcement** already mitigated via `checkUniqueViaIndex`'s live
  candidate validation (`manager.ts`); that stays correct and its now-accurate
  candidate set is strictly better. Update its comment that currently explains the
  stale-by-reference accumulation (it no longer accumulates).

## Out of scope / leave intact

- The `ownedEntries` copy-on-write design — preserve it; just swap the cloned
  container from `Set` to array.
- `checkUniqueViaIndex` / `checkUniqueViaMaterializedView` live-validation — keep
  as defense-in-depth even though scans/stats now trust the entry.

## TODO

- [ ] Add `primaryKeyComparator` to the `MemoryIndex` constructor; store it on the
      instance. Update the four `new MemoryIndex(...)` call sites in `base.ts` (×3)
      and `transaction.ts` (×1) to pass `createPrimaryKeyFunctions(schema).compare`.
- [ ] Change `MemoryIndexEntry.primaryKeys` in `types.ts` from
      `Set<BTreeKeyForPrimary>` to `BTreeKeyForPrimary[]` (sorted under the PK
      comparator). Update the doc comment.
- [ ] Rewrite `MemoryIndex.addEntry` / `removeEntry` / `getPrimaryKeys` to use
      binary-search value add/remove/contains under `primaryKeyComparator`,
      preserving the owned-vs-inherited copy-on-write branches (clone via `slice()`
      for inherited entries; empty-array ⇒ `deleteAt`).
- [ ] Audit every `.primaryKeys` consumer for `Set`-specific API use. Known sites:
      `scan-layer.ts` (2× `for…of`, array-OK), `index.ts` (owner),
      `base.ts:populateNewIndex` via `getPrimaryKeys`. Grep `\.primaryKeys` and
      `\.size`/`\.add`/`\.delete`/`\.has` on entries across the memory vtab.
- [ ] Update the stale-accumulation comments in `manager.ts:checkUniqueViaIndex`
      and the `ownedEntries` doc to reflect value semantics.
- [ ] Add a regression spec under `packages/quereus/test/vtab/` asserting at the
      `MemoryIndex` level: composite-PK `removeEntry` drops by value (count → 0);
      `addEntry` of an equal-by-value composite PK does not duplicate (count stays
      1); and a single-column integer entry removes correctly across `5n`/`5`
      representations. (Repro scaffold: build `ColumnSchema[]` via
      `createDefaultColumnSchema(name)` with `logicalType: INTEGER_TYPE`, then
      `new MemoryIndex({ name, columns: [{ index }] }, cols, pkCompare)`.)
- [ ] Add an end-to-end `.sqllogic` case in the `10.5*` neighborhood: composite-PK
      table + secondary index, UPDATE the indexed column, then scan for the OLD
      index value and assert zero rows (no phantom). If the access planner won't
      route through the secondary index reliably, assert at the `MemoryIndex` level
      instead (per the spec test above) and note the planner dependence.
- [ ] Run `yarn test` (memory-backed) and `yarn workspace @quereus/quereus run lint`.
      Spot-check the `51.9` (maintained secondary-UNIQUE) and composite-PK
      full-rebuild scenarios still pass.
