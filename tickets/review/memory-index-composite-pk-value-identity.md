description: MemoryIndexEntry.primaryKeys was a JS Set keyed by reference/SameValueZero identity. Composite PKs (fresh arrays per extraction) could never be removed by value and stored equal-by-value duplicates; integer PKs could diverge across bigint/number representations. Replaced the Set with a value-set: a sorted BTreeKeyForPrimary[] per entry, add/remove/contains via binary search under the table's PK comparator (collation- and representation-aware), threaded into MemoryIndex. Preserves the inherited-entry copy-on-write discipline (clone via slice()).
prereq:
files:
  - packages/quereus/src/vtab/memory/types.ts                       # MemoryIndexEntry.primaryKeys: Set -> sorted array; doc rewritten
  - packages/quereus/src/vtab/memory/index.ts                       # ctor gains primaryKeyComparator; findPrimaryKeyPosition/insertPrimaryKey/removePrimaryKey; addEntry/removeEntry/getPrimaryKeys rewritten; ownedEntries doc updated
  - packages/quereus/src/vtab/memory/layer/base.ts                  # 3 `new MemoryIndex(...)` sites pass this.primaryKeyFunctions.compare
  - packages/quereus/src/vtab/memory/layer/transaction.ts           # initializeSecondaryIndexes passes primaryKeyComparator before the inherited tree arg
  - packages/quereus/src/vtab/memory/layer/manager.ts               # checkUniqueViaIndex stale-accumulation comment updated to value semantics
  - packages/quereus/test/vtab/memory-index-pk-value-identity.spec.ts            # NEW unit regression (authoritative)
  - packages/quereus/test/logic/10.5.4-composite-pk-index-update-phantom.sqllogic # NEW e2e phantom test (planner-dependent — see gaps)
difficulty: medium
----

# Review: memory secondary-index entries track primary keys by value, not JS identity

## What changed (all implemented, build + tests + lint green)

`MemoryIndexEntry.primaryKeys` changed from `Set<BTreeKeyForPrimary>` to a
`BTreeKeyForPrimary[]` kept **sorted under the table's PK comparator**. The
comparator (`createPrimaryKeyFunctions(schema).compare`) is threaded into
`MemoryIndex` as a new constructor parameter and stored once per index (it is
identical for every entry).

- `MemoryIndex` gained three private helpers: `findPrimaryKeyPosition` (binary
  search → `{found, index}`), `insertPrimaryKey` (ordered insert, value-dedup),
  `removePrimaryKey` (value remove → bool).
- `addEntry` / `removeEntry` / `getPrimaryKeys` rewritten to use them:
  - **owned** entries mutate the array in place (`splice`);
  - **inherited** entries clone via `slice()` before mutating and land the
    replacement through `BTree.updateAt` (mirrors the old `new Set(existing)`
    copy-on-write — the `ownedEntries` discipline is preserved verbatim);
  - an entry whose array empties is `deleteAt`-removed (owned) or masked
    (inherited) — same branch structure as before;
  - `getPrimaryKeys` returns `entry.primaryKeys.slice()` (defensive copy).
- Constructor signature is now
  `(spec, allTableColumnsSchema, primaryKeyComparator, baseInheritreeTable?)`.
  The comparator was inserted **before** the optional inherited-tree arg, so the
  one positional `transaction.ts` call site moved the tree to the 4th slot.
- Four `new MemoryIndex(...)` sites updated: `base.ts` ×3
  (`createSecondaryIndexes`, `rebuildAllSecondaryIndexesStrict`, `addIndexToBase`)
  pass `this.primaryKeyFunctions.compare`; `transaction.ts` ×1
  (`initializeSecondaryIndexes`) passes the comparator from
  `getPkExtractorsAndComparators`.
- Doc/comment updates: `MemoryIndexEntry` doc, `ownedEntries` doc, and the
  `manager.ts:checkUniqueViaIndex` stale-by-reference comment (now: the entry
  tracks PKs by value; the live re-check remains as defense-in-depth only for
  genuine intra-statement candidate lag).

## Why correctness needs a comparator (not a canonical-string map)

The PK passed to `addEntry` (stored bytes, e.g. `'A'` for a NOCASE text PK on
INSERT) vs `removeEntry` (user-supplied key values, e.g. `'a'` on DELETE) can be
byte-different but comparator-equal. A representation-canonical string map keyed
on `'a'` would miss the stored `'A'`; a general custom collation exposes only a
`compare`. Only a comparator-backed structure is correct in general. PK-tree
uniqueness guarantees the live PKs in one entry are pairwise distinct under the
comparator, so a value-equal remove is unambiguous.

## Use cases to validate / re-check during review

- **Authoritative unit regression** — `test/vtab/memory-index-pk-value-identity.spec.ts`
  (5 cases, all passing) asserts at the `MemoryIndex` level:
  - composite-PK `removeEntry` of a *fresh equal-by-value* array drops the member
    (count → 0) **and** deletes the emptied entry (`index.size === 0`);
  - composite-PK `addEntry` of an equal-by-value array does not duplicate
    (count stays 1);
  - genuinely distinct composite PKs under one index key coexist (count 3) and a
    middle one removes by value;
  - single-column integer PK removes across `5n`/`5` representations (→ 0);
  - single-column integer PK dedups `5n` vs `5` on add (stays 1).
- **End-to-end** — `test/logic/10.5.4-composite-pk-index-update-phantom.sqllogic`:
  composite-PK table + secondary index on a non-PK column; UPDATE the indexed
  column, then seek the OLD value → `[]` (no phantom); seek NEW value → updated
  row; DELETE a composite-PK row → its index value drops out.
- **Spot-checks requested by the ticket, run via full `yarn test`:** `51.9`
  (maintained secondary-UNIQUE), `102*`/`102.2` (UNIQUE + collation), and the
  composite-PK full-rebuild paths all pass.
- Validation run: `yarn workspace @quereus/quereus run typecheck` (clean),
  `yarn workspace @quereus/quereus run test` → **6004 passing, 9 pending**,
  `yarn workspace @quereus/quereus run lint` (clean). Memory-backed only;
  `test:store` not run.

## Known gaps / where to push hardest (handoff is a floor, not a finish line)

- **The `.sqllogic` test is planner-dependent.** Its phantom-catching power
  relies on the access planner routing `WHERE v = <old>` through the `ci_v`
  secondary index. I did **not** confirm the planner actually uses the index here
  — if it full-scans the primary tree, the e2e test passes even against the old
  buggy code (it would still assert the correct empty result). The unit spec is
  the real regression. A reviewer wanting e2e teeth should verify the index path
  is taken (e.g. `--show-plan`) or treat the unit-level coverage as the floor.
  The file comment states this dependence.
- **Performance of sorted-array splice.** Add/remove is O(n) per entry. The
  dominant case (one PK per entry) is trivial, but a pathological low-cardinality
  *non-unique* index (few distinct keys, many PKs each) could feel the O(n)
  splice. Not benchmarked. The ticket's fallback (BTree-per-entry via
  base-inheritance) is documented as the escalation if profiling ever shows this.
- **`base.ts` uses `this.primaryKeyFunctions.compare`** rather than recomputing
  `createPrimaryKeyFunctions(schema).compare`. Same function, fewer allocations.
  I verified `primaryKeyFunctions` is current at every site (constructor and
  `addColumnToBase` re-init before the rebuild; strict-rebuild/`addIndexToBase`
  run post-construction). Worth a second pair of eyes that no site reaches a
  `new MemoryIndex` with a stale `primaryKeyFunctions`.
- **Cross-layer comparator consistency** rests on the invariant that a
  PK-collation change forces a full base rebuild (so no inherited array survives
  with a stale sort order) and that a transaction layer's schema is fixed at
  creation (`tableSchemaAtCreation`). Documented in the `primaryKeyComparator`
  doc comment; a reviewer could probe a savepoint/nested-transaction-over-ALTER
  edge if one is reachable.
- **Inherited duplicate-add still does a COW write.** When `addEntry` targets an
  inherited entry and the PK is already present, it still clones + `updateAt`
  (a value no-op). This matches the old `new Set(existing).add(pk)` behavior
  exactly; not changed, but flagged as a (pre-existing) minor inefficiency.

## Out of scope / intentionally left intact

- The `ownedEntries` copy-on-write design — preserved; only the cloned container
  changed from `Set` to `slice()`d array.
- `checkUniqueViaIndex` / `checkUniqueViaMaterializedView` live candidate
  validation — kept as defense-in-depth (now operating on an accurate candidate
  set).
