---
description: |
  When the isolation layer wraps another storage module, any query that filters on a column crashes as soon
  as the surrounding transaction has already written something. The isolation overlay replays the underlying
  module's chosen index name against its own private scratch table, which only knows its own index names, and
  throws "Secondary index '…' not found" instead of coping. Only the primary-key case is special-cased today.
files:
  - packages/quereus-isolation/src/isolated-table.ts       # :426/:488 mergedQuery/mergedSecondaryIndexQuery replay underlying idxStr; :594 adaptFilterInfoForOverlay (the _primary_ bridge); getIndexColumnIndices returns [] on miss (silent mis-key); PK_INDEX_NAME_RE
  - packages/quereus-isolation/src/isolation-module.ts     # createOverlaySchema — overlay index set is baseSchema.indexes verbatim
  - packages/quereus/src/vtab/memory/layer/scan-layer.ts   # :189 the throw site (Secondary index not found)
  - packages/quereus/src/vtab/memory/layer/scan-plan.ts    # resolveIndexName/resolveIndexSchema — resolves against tableSchema.indexes
  - packages/quereus/src/vtab/virtual-table.ts             # VirtualTable.getIndexComparator(indexName) — the surface the overlay should consult for underlying emission order
difficulty: hard
---

# Isolation overlay cannot resolve an index name minted by the underlying module

## Cross-repo origin

Filed from the lamina project, where it blocks
`tickets/blocked/quereus-isolation-overlay-cannot-serve-underlying-index-names.md`. Reproduced there with
`IsolationModule` over `LaminaModule`; the acceptance check is un-skipping
`packages/lamina-quereus-test/src/isolation-overlay-underlying-index-names.test.ts`. Affects **any** host
that wraps a module minting non-PK index names in `IsolationModule` and reads inside a transaction that has
written — not lamina-specific.

## What breaks

`IsolationModule` gives each connection an overlay: a private `MemoryTable` holding that connection's
uncommitted rows. A read whose transaction has already written takes the merged path, which replays the
**underlying module's** `filterInfo` — `idxStr` included — against the overlay. The overlay tries to resolve
the index named in that `idxStr` and throws:

```
QuereusError: Secondary index '_compound__pk_InstalledLibrary_0' not found.   (StatusCode.INTERNAL)
  scanLayerResolved            vtab/memory/layer/scan-layer.ts:189
  MemoryTable.query            vtab/memory/table.ts
  IsolatedTable.mergedSecondaryIndexQuery  quereus-isolation/src/isolated-table.ts
```

The two modules do not share an index vocabulary: the overlay's index set is copied straight off the
`TableSchema.indexes` array (`createOverlaySchema`; `scan-plan.resolveIndexSchema` looks names up there),
but an underlying module's scan shapes need not be schema indexes at all — it can mint synthetic names
(lamina mints `_primary_`, `_column_<id>_`, `_compound_<name>_`, `_nd_<name>_`, `_intersect_<ids>_`, plus a
monotonic per-plan sequence suffix). No name outside the PK family can ever exist on the overlay, by
construction.

The PK family works only because `@quereus/isolation` already special-cases it: `PK_INDEX_NAME_RE`
(`/^_primary_\d*$/`) classifies the suffixed name as a PK scan, and `adaptFilterInfoForOverlay` rewrites the
`idxStr` back to the overlay's own `_primary_`. That bridge is the right idea, applied to exactly one of the
five families. A full scan works because it carries no `idxStr`.

## Second, quieter defect on the same seam

`getIndexColumnIndices` returns `[]` when the name misses `tableSchema.indexes` — which, per the above, is
*always*, for every non-PK underlying shape. `buildSortKey` then builds a sort key of PK columns only, while
the underlying stream arrives in **index** order. If the throw were removed without addressing this, the
merge in `mergedSecondaryIndexQuery` would compare mis-keyed rows and silently drop or misorder them. A fix
must close **both**.

## Candidate directions (engine-design call)

- **Overlay stops resolving foreign index names.** It is a delta, not a replica. When the name is not one it
  owns, scan the overlay in full (it holds one transaction's writes), apply the query's constraints itself,
  and merge in whatever order the underlying's stream arrives in. That requires knowing the underlying's
  emission order, for which the engine already has `VirtualTable.getIndexComparator(indexName)` — the
  isolation layer does not currently consult it for this purpose.
- Or **generalize the `_primary_` bridge** into a real classify-and-translate step over all index-name
  families the underlying advertises.

Either way pair the fix with a `MemoryTable` (or test module) underlying that mints a name the overlay does
not know, so the contract is pinned engine-side, not only against lamina.

## Design constraints

- Do not push this back onto the underlying module: it cannot pre-declare its scan shapes in
  `TableSchema.indexes` (the name embeds a plan-time sequence suffix), cannot drop the suffix (it prevents an
  ascending and a descending plan over one index from clobbering each other in one statement), and must keep
  advertising secondary indexes (dropping them de-optimizes every non-isolated scan).
- Fix both the throw and the `getIndexColumnIndices → []` mis-key, or the merge silently corrupts results.

## TODO

- Reproduce with a memory/test underlying that mints a non-PK index name (pins the contract without lamina).
- Pick a direction; implement classify-and-translate or full-overlay-scan-with-comparator.
- Regression: merged read under an open, already-written transaction over a non-PK index name, asserting
  correct row set **and** order.
- On landing, lamina un-skips `isolation-overlay-underlying-index-names.test.ts` as its acceptance check.

## Note for the lamina side

A separate lamina-only stopgap (advertise a compound full-PK equality lookup as `_primary_` so the existing
bridge serves it) is under human consideration in the lamina ticket; it fixes only the compound-PK shape and
does not substitute for this engine fix. Independent of this ticket.
