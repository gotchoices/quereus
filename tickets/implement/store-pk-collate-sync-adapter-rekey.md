description: Land the sync store-adapter per-column PK key-collation fix. The code change is already applied and verified in tree by the fix stage — remaining work is broad validation (full build + cross-workspace tests) and the review handoff.
files: packages/quereus-sync/src/sync/store-adapter.ts, packages/quereus-store/src/common/index.ts, packages/quereus-sync/test/sync/store-adapter-pk-collation.spec.ts, packages/quereus-sync/test/sync/sync-protocol-e2e.spec.ts, packages/quereus-store/README.md
----

## Problem (recap)

`store-pk-collate-physical-rekey` made the store encode each text PK column's data-key
bytes under that column's own declared collation (`StoreTable.pkKeyCollations` →
`buildDataKey(pk, opts, dirs, collations)`). The sync adapter's `applyRowChanges`
(`packages/quereus-sync/src/sync/store-adapter.ts`) reconstructed the data key from the
table-level collation K only (no 4th `buildDataKey` argument), so for any synced table with
a divergent per-column PK collation (e.g. `x text collate binary primary key` on a
default-NOCASE store) the adapter computed different key bytes than the store module:

- remote **insert** landed at a phantom key invisible to point lookups;
- remote **delete** missed the store's row, which survived;
- remote **update** UPSERT-missed the existing row and wrote a duplicate phantom row.

All three modes were reproduced by the fix stage with a real `Database` + `StoreModule` +
`InMemoryKVStore` harness (3 of 4 tests in the new spec failed pre-fix; the
matching-collation control passed).

## The fix (already applied in tree)

The adapter now keys rows identically to `StoreTable`:

- `packages/quereus-store/src/common/index.ts` — added `resolvePkKeyCollations` to the
  `./store-table.js` export block, making it public via the `@quereus/store` barrel
  (`src/index.ts` re-exports `common/index.js` wholesale).
- `packages/quereus-sync/src/sync/store-adapter.ts` — `applyRowChanges` computes
  `const pkCollations = resolvePkKeyCollations(tableSchema.primaryKeyDefinition, tableSchema.columns, collation)`
  and passes it as the 4th argument to `buildDataKey`. `collation` (the adapter option,
  default `'NOCASE'`) is the fallback K, matching `StoreTable`'s
  `encodeOptions.collation ?? 'NOCASE'`.
- `packages/quereus-sync/test/sync/store-adapter-pk-collation.spec.ts` — new regression
  spec (4 tests: control round-trip with matching collation, plus insert / delete / update
  on a `collate binary` PK over a NOCASE store, applied through `createStoreAdapter`
  against the same provider-backed KV store the `StoreModule` uses, asserted through SQL).
- `packages/quereus-sync/test/sync/sync-protocol-e2e.spec.ts` — the three hand-rolled mock
  `tableSchema` objects gained minimal `logicalType: { isTextual: … }` fields on their
  columns: `resolvePkKeyCollations` reads `col.logicalType.isTextual`, and the bare mocks
  (cast via `as unknown as TableSchema`) made the adapter throw, failing
  "should write to the correct KV store for each table".
- `packages/quereus-store/README.md` — `resolvePkKeyCollations` row added to the
  Core Exports table.

Validation already done by the fix stage:
- `yarn workspace @quereus/store run typecheck` and `yarn workspace @quereus/sync run typecheck` clean;
- `yarn workspace @quereus/store run build` clean (sync tests import `@quereus/store` from dist);
- full quereus-sync suite: **167 passing, 0 failing** (163 pre-existing + 4 new).

## Notes

- The adapter's single `buildDataKey` call is the **only** data-key reconstruction in
  sync-land — grep across quereus-sync, quereus-sync-client, and sync-coordinator for
  `buildDataKey|buildIndexKey|encodeCompositeKey` finds no other site.
- The adapter still maintains no secondary indexes / covering MVs / watches on applied
  changes — that pre-existing gap is tracked by `external-row-change-ingestion` (plan/),
  whose use-case section explicitly names this ticket. Out of scope here.

## TODO

- Confirm the tree matches the description above (the fix-stage commit carries all five files).
- Run the quereus-store package test suite (`yarn workspace @quereus/store run test`).
- Run `yarn build` and `yarn test` from the root (cross-workspace sanity; lint only exists
  for packages/quereus, whose sources are untouched).
- Write the review/ handoff, noting the e2e mock-schema change as a reviewer focal point
  (minimal-mock vs. fuller schema fixtures) alongside the adapter/barrel diff.
