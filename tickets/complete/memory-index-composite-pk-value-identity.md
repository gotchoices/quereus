description: MemoryIndexEntry.primaryKeys changed from a JS Set (reference/SameValueZero identity — broken for composite array PKs and bigint/number-divergent integer PKs) to a sorted BTreeKeyForPrimary[] kept ordered under the table's PK comparator, with add/remove/contains via binary search. The comparator is threaded into MemoryIndex as a constructor parameter. Inherited-entry copy-on-write discipline preserved (clone via slice()).
files:
  - packages/quereus/src/vtab/memory/types.ts
  - packages/quereus/src/vtab/memory/index.ts
  - packages/quereus/src/vtab/memory/layer/base.ts
  - packages/quereus/src/vtab/memory/layer/transaction.ts
  - packages/quereus/src/vtab/memory/layer/manager.ts
  - packages/quereus/test/vtab/memory-index-pk-value-identity.spec.ts
  - packages/quereus/test/logic/10.5.4-composite-pk-index-update-phantom.sqllogic
----

# Complete: memory secondary-index entries track primary keys by value, not JS identity

## Summary

`MemoryIndexEntry.primaryKeys` is now a `BTreeKeyForPrimary[]` kept sorted under
the table's PK comparator (`createPrimaryKeyFunctions(schema).compare`), threaded
into `MemoryIndex` as a constructor parameter. Members are added/removed/found by
*value* via binary search (`findPrimaryKeyPosition` / `insertPrimaryKey` /
`removePrimaryKey`). This fixes two latent correctness bugs of the prior JS `Set`:
composite (array) PKs — freshly allocated each extraction — could never be removed
by value and stored equal-by-value duplicates; scalar integer PKs diverged across
`5n`/`5`. The inherited-entry copy-on-write discipline (clone before mutating so a
layer's writes never corrupt the committed base it inherits) is preserved verbatim,
with the cloned container changing from `new Set(existing)` to `existing.slice()`.

The implementation, build, lint, and full memory-backed test suite were all green
on handoff; review reproduced that and confirmed the design holds.

## Review findings

### Verified correct (checked, no action needed)

- **Comparator consistency end-to-end.** Every `addEntry`/`removeEntry` PK is
  produced by `primaryKeyFunctions.extractFromRow` or `buildPrimaryKeyFromValues`
  (base.ts populate, transaction.ts recordUpsert/recordDelete), i.e. the same PK
  definition that backs the comparator the array is sorted by. The PK comparator
  is also the primary tree's BTree comparator, so it is a proven total order —
  binary search is well-defined. PK-tree uniqueness guarantees the live PKs in one
  entry are pairwise distinct under the comparator, so a value match is unambiguous
  (no "which duplicate" question). The "no PK defined" singleton case (compare ≡ 0)
  is safe: such tables hold ≤1 row, hence ≤1 PK per entry.
- **All `new MemoryIndex(...)` sites pass a current comparator.** base.ts ×3 use
  `this.primaryKeyFunctions.compare` (verified current at each site:
  constructor/`addColumnToBase` re-init before rebuild; strict-rebuild and
  `addIndexToBase` run post-construction). transaction.ts derives it from
  `getPkExtractorsAndComparators(tableSchemaAtCreation)`. No site reaches a stale
  `primaryKeyFunctions`.
- **All `primaryKeys` consumers are array-compatible.** scan-layer.ts (equality
  + range secondary scans) and manager.ts `checkUniqueViaIndex` iterate the value;
  base.ts `populateNewIndex` uses `.length > 0`. None depended on `Set` methods.
- **Inherited copy-on-write isolation** (the riskiest change — container type
  swap under rollback) holds: `ownedEntries` is a per-instance WeakSet, so a base
  entry is "inherited" for the child and is cloned via `slice()` before any splice;
  the empty-after-remove case masks via `deleteAt` in the child tree only. Branch
  structure is identical to the prior Set code.
- **e2e index path confirmed (resolved the handoff's main flagged gap).** The
  implementer flagged that `10.5.4-...phantom.sqllogic` only has teeth if the
  planner routes `WHERE v = <old>` through the secondary index. Verified via
  `getPlan`: the query plans to `IndexSeek ci USING ci_v`, so the test exercises
  the secondary-index path and would surface the phantom against the pre-fix code.
  The test is meaningful, not just incidentally-passing.

### Fixed in this pass (minor)

- **Added inherited copy-on-write unit coverage.** The implementer's unit spec
  exercised only *owned* entries (a standalone `MemoryIndex`, no base inheritree);
  the inherited COW path — the single most intricate part of the diff — was covered
  only implicitly by e2e DML. Added a `makeChildIndex` helper (wraps a base index's
  tree, the same wiring TransactionLayer uses) and three cases to
  `test/vtab/memory-index-pk-value-identity.spec.ts`: inherited `addEntry` of a
  distinct composite PK does not mutate the base entry; inherited `removeEntry` that
  empties the entry leaves the base intact (masked in child only); inherited
  duplicate `addEntry` neither duplicates nor mutates the base. All pass (8 total in
  the file).

### Filed as follow-up (major)

- **`tickets/backlog/memory-index-primarykeys-sorted-array-on2-buildcost.md`** —
  the sorted-array splice is O(n) per add/remove, so a low-cardinality NON-UNIQUE
  index (few distinct keys, many PKs each — e.g. an index on a status/flag column
  over a large table) builds in O(N²). The prior Set was O(1) but value-incorrect,
  so this cannot be reverted; the fix is a per-entry container redesign (e.g. lazy
  per-entry BTree) that needs profiling first. Speculative until benchmarked; the
  dominant one-PK-per-entry path is unaffected.

### Noted, intentionally not actioned (minor / pre-existing)

- **Inherited duplicate-add still does a COW `updateAt`** even when the PK is
  already present (a value no-op that transfers ownership). This exactly matches the
  prior `new Set(existing).add(pk)` behavior — pre-existing, not a regression, and
  micro. Left as-is.
- **Row-yield order for a secondary-index equality scan changed** from Set
  insertion order to PK-sorted order. Without an `ORDER BY` this is unspecified, and
  PK-sorted is strictly more deterministic; the full suite passes unchanged. A
  behavioral improvement, no action.

## Validation

- `yarn workspace @quereus/quereus run lint` — clean.
- `yarn workspace @quereus/quereus run typecheck` — clean.
- `yarn workspace @quereus/quereus run test` — **6004 passing, 9 pending** (memory
  backed). `test:store` not run (memory-vtab-internal change; the store module uses
  a separate code path).
- New/expanded `memory-index-pk-value-identity.spec.ts` — 8 passing (5 original +
  3 inherited-COW).
- `10.5.4-composite-pk-index-update-phantom.sqllogic` — passing; index path
  confirmed via `getPlan`.

## Scope left intact

- `ownedEntries` copy-on-write design (only the cloned container changed).
- `checkUniqueViaIndex` / `checkUniqueViaMaterializedView` live candidate
  validation — kept as defense-in-depth (now over an accurate candidate set).
