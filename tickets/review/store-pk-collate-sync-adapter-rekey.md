description: Review the sync store-adapter per-column PK key-collation fix — the adapter now reconstructs data keys with resolvePkKeyCollations so remote insert/delete/update land on the same key bytes StoreTable writes.
files: packages/quereus-sync/src/sync/store-adapter.ts, packages/quereus-store/src/common/index.ts, packages/quereus-sync/test/sync/store-adapter-pk-collation.spec.ts, packages/quereus-sync/test/sync/sync-protocol-e2e.spec.ts, packages/quereus-store/README.md
----

## What changed and why

`store-pk-collate-physical-rekey` made `StoreTable` encode each text PK column's data-key
bytes under that column's own declared collation (`pkKeyCollations` → 4th argument of
`buildDataKey`). The sync adapter's `applyRowChanges`
(`packages/quereus-sync/src/sync/store-adapter.ts`) still keyed remote changes from the
table-level collation K alone, so any synced table whose PK column collation diverges from
K (e.g. `x text collate binary primary key` on a default-NOCASE store) was corrupted by
remote changes: inserts landed at phantom keys invisible to point lookups, deletes missed
the store's row, and updates UPSERT-missed and wrote a duplicate phantom row.

The fix (small, surgical):

- `store-adapter.ts` — `applyRowChanges` now computes
  `resolvePkKeyCollations(tableSchema.primaryKeyDefinition, tableSchema.columns, collation)`
  and passes it as `buildDataKey`'s 4th argument. The fallback K is the adapter option
  `collation` (default `'NOCASE'`), matching `StoreTable`'s
  `encodeOptions.collation ?? 'NOCASE'`. This is the **only** data-key reconstruction in
  sync-land (grep across quereus-sync, quereus-sync-client, sync-coordinator for
  `buildDataKey|buildIndexKey|encodeCompositeKey` finds no other site).
- `quereus-store/src/common/index.ts` — `resolvePkKeyCollations` added to the
  `./store-table.js` export block, making it public through the `@quereus/store` barrel.
- `quereus-store/README.md` — Core Exports table row for the new export.

## Tests added

`packages/quereus-sync/test/sync/store-adapter-pk-collation.spec.ts` — 4 tests driving a
real `Database` + `StoreModule` + provider-backed `InMemoryKVStore` through
`createStoreAdapter`, asserting through SQL:

- control round-trip (PK collation matches K) — passed pre-fix;
- remote insert on a `collate binary` PK is visible to a point lookup;
- remote delete removes the store-written row (asserted via full scan, deliberately
  independent of point-lookup key bytes);
- remote update modifies the row in place (no phantom duplicate).

The latter three reproduced the bug pre-fix (verified by the fix stage).

## Reviewer focal points

1. **The e2e mock-schema change** (`sync-protocol-e2e.spec.ts`): three hand-rolled
   `tableSchema` mocks (cast `as unknown as TableSchema`) gained minimal
   `logicalType: { isTextual: … }` fields, because `resolvePkKeyCollations` reads
   `col.logicalType.isTextual` and threw on the bare mocks. Judge whether minimal mocks
   are acceptable here or whether these fixtures should be built from real schemas — they
   are now coupled to whichever schema fields the adapter happens to read.
2. **Collation resolution parity**: confirm the adapter's
   `resolvePkKeyCollations(pkDef, columns, collation)` call mirrors `StoreTable`'s own
   usage (`store-table.ts:216/238/346` and `store-module.ts:644`), including the fallback-K
   semantics, so the two can't drift for non-text PKs or multi-column PKs.
3. The barrel export — `resolvePkKeyCollations` is now public API of `@quereus/store`;
   check the README row and that the export block is the right home.

## Known gaps (out of scope, tracked elsewhere)

- The adapter still maintains **no secondary indexes, covering MVs, or watches** on
  applied remote changes — pre-existing gap tracked by `external-row-change-ingestion`
  (plan/), whose use-case section names this ticket.
- The new spec runs only against `InMemoryKVStore`; key-byte construction is
  store-agnostic, so no LevelDB-path variant was added.

## Validation (implement stage)

- `yarn build` from root: clean, exit 0.
- `yarn workspace @quereus/store run test`: 400 passing, 0 failing.
- `yarn test` from root: all workspaces green — quereus 5550 passing / 9 pending,
  store 400, sync 167 (163 pre-existing + 4 new), coordinator 121, others all passing;
  "Done in 4m 21s", no failures.
- Typechecks for @quereus/store and @quereus/sync were run clean by the fix stage.
