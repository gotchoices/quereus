---
description: Inside a transaction, reads over a storage module's own index must also show the transaction's uncommitted changes. Teach the transaction layer to merge those changes into a lookup that delivers module-listed values, including one over an index (such as a multi-dimensional one) whose row order cannot be described.
prereq: module-listed-seek-arguments-planner
architecture: docs/design-isolation-layer.md#key-ordering
files:
  - packages/quereus-isolation/src/isolated-table.ts      # IndexScanInfo; resolveScanIndex; mergedQuery; mergedSecondaryIndexQuery step 1 (factor out); buildConstraintMatcher; constraintComparator
  - packages/quereus-isolation/test/                       # new spec + small test double (pattern: claimed-non-seek-filter.spec.ts)
  - docs/design-isolation-layer.md                         # "Which index is being scanned" table + paragraph
---

# Module-listed seek arguments — isolation overlay half

The prereq adds `BestAccessPlanResult.moduleSeekFilters`: a module lists the filters it enforces inside its chosen index and receives their values at `query()` time, as plan kind `moduleSeek` (`plan=8`). Its `FilterInfo.constraints` are one genuine (column, operator, value) triple per listed filter, AND-ed together. The access path is `{ kind: 'index', … plan: 'moduleSeek' }` when the engine can resolve the index, and the new `{ kind: 'unorderedIndex', indexName, plan }` when it cannot and the plan claims no order (`providesOrdering` empty, no `monotonicOn`). The prereq leaves `IsolatedTable.resolveScanIndex` throwing INTERNAL on `unorderedIndex`.

`IsolatedTable` merges the transaction's staged rows (the overlay) into the underlying module's stream. Two things are wrong for a moduleSeek read today.

## 1. A stream with no describable order

Lamina's nD-tree index emits a filter-only box scan in an order no `IndexDescriptor` can state, so its plans arrive as `unorderedIndex`. Nothing above relies on that order (the planner kept any `Sort`), so the merge only has to produce the right **set** of rows:

- `IndexScanInfo` gains `{ type: 'unordered' }`; `resolveScanIndex` maps `unorderedIndex` to it.
- `mergedQuery` routes it to a new `mergedUnorderedQuery`: full-scan the overlay once, collecting the shadowed primary keys and the in-window non-tombstone rows — exactly step 1 of `mergedSecondaryIndexQuery`, so factor that step into one helper both call (same `makePkKeySerializer` shadow key; never re-derive it). Then stream the underlying (`underlyingFilterInfoForMerge(filterInfo, [])`, so required columns gain the primary key), dropping rows whose key the overlay shadows, and finally yield the collected overlay rows. No sort, no interleave. When `overlay.query` is missing, pass through to the underlying as the secondary path does.
- The primary-key merge (`mergeStreams`) is never used for this kind: its shadowing depends on order.

## 2. The window matcher reads EQ constraints as an IN set

`buildConstraintMatcher` treats several `EQ` constraints on one column as an `IN` list (that is how the engine encodes a multi-seek). A moduleSeek's constraints are a conjunction: `a = 1 and a = 2` listed by the module returns nothing from the underlying, but the matcher would admit a staged row with `a = 1`, and because the module handled the listed filters no `Filter` above re-checks it. For plan `moduleSeek` (either access-path kind), the matcher must require **every** constraint: each `EQ` value must compare equal, and every range bound must hold (ranges already AND). Null semantics unchanged: a null row value or null operand never matches.

The matcher must also accept the `unorderedIndex` kind (today it returns match-all for anything but `index`, which would leak every staged row into the box).

Comparator collation for a moduleSeek window: the key column's collation when the resolved descriptor holds the column, else **BINARY** — the same assumption the planner's collation cover made when it accepted the seek (it declines a listed filter unless predicate collation equals that collation), so the matcher reproduces the predicate exactly. Do not fall back to the table column's declared collation for this plan kind (the existing plan kinds keep their current fallback). The semantic-ordering arm (`createTypedComparator` for TIMESPAN/JSON) applies as today. Parameterize `constraintComparator` (descriptor optional, fallback collation chosen by the caller) rather than copying it.

## Edge cases & interactions

- Staged insert inside the box, staged insert outside it, staged update moving a committed row out of the box, staged update moving one into it, staged delete (tombstone) of a committed in-box row: the merged answer equals the answer after commit. Test.
- Underlying stream in non-primary-key order: the unordered merge must not depend on it. The test double emits in reverse insertion order. Test (same test).
- `a = 1 and a = 2` conjunction on a resolved-index moduleSeek with a staged `a = 1` row → no row. Test.
- Dynamic null argument → matcher rejects every staged row, underlying returns none. Inspection.
- Tombstones carry null non-key columns: they still only shadow, never match the window (unchanged). Inspection.
- A moduleSeek over a resolved descriptor with `role: 'primary'` still takes the primary-key merge, which hands the overlay the underlying's FilterInfo: `adaptFilterInfoForOverlay` / `queryOverlayAsMergeEntries` re-apply the (now conjunctive) matcher, so a scan-only overlay that answers plan 8 with a superset stays correct. But the default memory overlay does not understand `plan=8`: confirm what it does with an unknown plan code on `_primary_` (it should fall back to a full walk; if it throws, re-plan the overlay side as a full scan for `moduleSeek`, the way the secondary path already full-scans). Verify by reading the memory scan-plan builder; add a test only if a change is needed.
- `unresolvedIndex` (ordered claim, no descriptor) still throws INTERNAL as today. Inspection.
- `readCommitted` / no-overlay reads bypass the merge (unchanged). Inspection.

## Tests

A small test double in `packages/quereus-isolation/test/` (the module in `quereus/test/vtab/test-module-seek-module.ts` is not importable across packages; keep this one minimal): array-backed, lists every handled `=`/range filter as `moduleSeekFilters` on a minted index name with no descriptor (→ `unorderedIndex`) or on a schema index name (→ resolved `index`), applies the constraints in `query()`, emits in reverse insertion order. Wrap it with `IsolationModule`, following `claimed-non-seek-filter.spec.ts`'s "answer inside the transaction equals the answer after commit" helper.

- Box read under staged insert/update/delete (the five cases above) over the unordered index.
- Conjunctive EQ over a resolved index with a staged row matching one of two contradictory equalities.

## TODO

- Add `{ type: 'unordered' }` to `IndexScanInfo` and map `unorderedIndex` to it in `resolveScanIndex`, replacing the prereq's INTERNAL throw.
- Factor step 1 of `mergedSecondaryIndexQuery` into a helper; add `mergedUnorderedQuery` and route to it from `mergedQuery`.
- Make `buildConstraintMatcher` accept `unorderedIndex` and apply conjunctive semantics plus the BINARY-when-undescribed comparator for plan `moduleSeek`; parameterize `constraintComparator`.
- Check the memory overlay's handling of `plan=8` on the primary-key merge path; fix only if it throws or under-returns.
- Write the test double and spec.
- Docs: in `docs/design-isolation-layer.md` "Which index is being scanned", add the `unorderedIndex` row (set merge: drop shadowed keys, append in-window staged rows; output order unspecified, which is sound because the plan claimed none) and a sentence that moduleSeek windows are conjunctions.
- `yarn build`, `yarn test` green.
