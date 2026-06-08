description: Store module honors DESC direction in primary-key (and index) natural iteration order
files:
  packages/quereus-store/src/common/encoding.ts
  packages/quereus-store/src/common/key-builder.ts
  packages/quereus-store/src/common/store-table.ts
  packages/quereus-store/src/common/store-module.ts
  packages/quereus-sync/src/sync/store-adapter.ts
  packages/quereus-store/test/encoding.spec.ts
  packages/quereus-store/test/key-builder.spec.ts
  packages/quereus-store/test/pk-desc-iteration.spec.ts
  packages/quereus/test/logic/40.1-pk-desc-direction.sqllogic
----

## What landed

Byte-level DESC encoding now threads through the storage layer so that natural
KV iteration order matches declared per-column direction:

- `encodeCompositeKey(values, options, directions?)` bit-inverts (`^0xff`)
  every byte of components flagged DESC. Bit-inversion of a fixed-width
  sortable encoding preserves inverse byte-lex order per component without
  disturbing composite ordering.
- `buildDataKey(pk, options, directions?)` forwards `directions` to the
  composite encoder.
- `buildIndexKey(indexValues, pkValues, options, indexDirections?, pkDirections?)`
  takes independent DESC flags for the index half and the PK suffix.
- `buildFullScanBounds()` is now unbounded (`{ gte: Uint8Array(0) }`). The
  former `lt: [0xff]` ceiling would have excluded any key whose first byte
  was 0xff — which happens whenever a DESC column's encoded type prefix
  (NULL 0x00, INTEGER 0x01, …) is inverted.
- `buildIndexPrefixBounds(values, options, directions?)` accepts per-component
  directions for prefix probes against DESC indexes.
- `StoreTable` captures `pkDirections` in the constructor and refreshes it
  from `updateSchema` (ALTER), then passes it to every `buildDataKey` site
  (`query`, INSERT/UPDATE/DELETE, `rekeyRows`, REPLACE eviction).
- `updateSecondaryIndexes` and `StoreModule.buildIndexEntries` (CREATE INDEX
  on existing rows) compute both halves' directions and pass them to
  `buildIndexKey`.
- `store-adapter.ts` (sync apply path) threads PK directions from the
  resolved `TableSchema`.

## How it's verified

- `packages/quereus-store/test/encoding.spec.ts` — single-column DESC for
  INT/TEXT/REAL, mixed ASC/DESC composite shapes, and `directions=undefined`
  parity with all-false ASC.
- `packages/quereus-store/test/key-builder.spec.ts` — DESC on `buildDataKey`
  + `buildIndexKey` (independent halves) and the unbounded
  `buildFullScanBounds` shape.
- `packages/quereus-store/test/pk-desc-iteration.spec.ts` — end-to-end SQL
  against `StoreModule` (no isolation overlay): INTEGER/TEXT/REAL column-level
  DESC, table-level constraint DESC, composite mixed (ASC, DESC), and
  UPDATE/DELETE round-tripping through the encoded DESC PK key. Closes the
  gap left when 40.1-pk-desc-direction.sqllogic moved to MEMORY_ONLY_FILES
  (skipped in store mode for an unrelated isolation-overlay merge issue).
- `packages/quereus/test/logic/40.1-pk-desc-direction.sqllogic` — end-to-end
  scenarios under the memory module.

## Validation

- `yarn workspace @quereus/store run build` — clean.
- `yarn workspace @quereus/store test` — 223 passing (216 prior + 7 new
  PK-DESC integration cases).
- 40.1 sqllogic — passing.

## Notes

- `buildIndexPrefixBounds([])` (empty prefix) still returns `{ gte: [], lt: [0xff] }`.
  This is unused by current consumers (only the deprecated wrapper
  `buildIndexScanBounds` calls it); if a future consumer needs to scan an
  entire DESC index store, switch to unbounded like `buildFullScanBounds`.
- The 40.1 sqllogic's skip in store mode is owned by a separate ticket on the
  isolation overlay's merge order — not a regression of this work.
