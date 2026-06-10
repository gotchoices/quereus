description: Sync store-adapter now reconstructs remote-change data keys with resolvePkKeyCollations, matching StoreTable's per-column PK key collation bytes — reviewed and confirmed.
files: packages/quereus-sync/src/sync/store-adapter.ts, packages/quereus-store/src/common/index.ts, packages/quereus-store/README.md, packages/quereus-sync/test/sync/store-adapter-pk-collation.spec.ts, packages/quereus-sync/test/sync/sync-protocol-e2e.spec.ts
----

# Summary

`store-pk-collate-physical-rekey` made `StoreTable` encode each text PK column's data-key
bytes under that column's own declared collation. The sync adapter's `applyRowChanges`
still keyed remote changes from the table-level collation K alone, corrupting any synced
table whose PK column collation diverges from K (phantom-key inserts, missed deletes,
duplicate-row updates).

The fix: `applyRowChanges` computes
`resolvePkKeyCollations(tableSchema.primaryKeyDefinition, tableSchema.columns, collation)`
and passes it as `buildDataKey`'s 4th argument, with fallback K = the adapter's
`collation` option (default `'NOCASE'`), exactly mirroring `StoreTable`.
`resolvePkKeyCollations` was made public through the `@quereus/store` barrel
(`common/index.ts`, in the `./store-table.js` export block) with a README Core Exports row.

## Review findings

### Checked

- **Implement-stage diff read first, fresh eyes** (code landed in the fix-stage commit
  `16929691`; the implement commit only moved the ticket). The adapter change is the
  one-line-plus-import surgical fix described.
- **Collation resolution parity with StoreTable** (focal point 2): the adapter's
  `resolvePkKeyCollations(pkDef, columns, collation)` is identical in shape and fallback
  semantics to `StoreTable`'s constructor/`updateSchema`/`rekeyRows`
  (`encodeOptions.collation ?? 'NOCASE'` where `encodeOptions.collation =
  config.collation || 'NOCASE'`) and `StoreModule.buildIndexEntries`. Non-text PK members
  resolve to `undefined` in both (encoder ignores collation for them); multi-column PKs
  map per-member. Since both sides call the same shared function with the same fallback,
  they cannot drift.
- **Only key-reconstruction site in sync-land**: `git grep` for
  `buildDataKey|buildIndexKey|encodeCompositeKey` across quereus-sync,
  quereus-sync-client, and sync-coordinator confirms `store-adapter.ts` is the sole site
  (snapshot bootstrap and delta apply both route through the same
  `ApplyToStoreCallback`). Real consumer (quoomb-web worker) passes `collation: 'NOCASE'`
  matching its store config `{ collation: 'NOCASE' }` — no live drift.
- **Barrel export placement** (focal point 3): `resolvePkKeyCollations` exported from the
  `./store-table.js` block where it's defined — right home; README row present and
  accurate.
- **E2e mock-schema judgment** (focal point 1): the minimal
  `logicalType: { isTextual }` mocks are acceptable — those tests are deliberately
  Database-free protocol-level tests, and building real schemas would couple them to the
  engine's schema builders for no assertion benefit. The coupling concern was real
  though, so the three byte-identical mocks were DRY'd into one documented
  `makeTestTableSchema(): TableSchema` factory (see fixes below). Noted in passing: only
  the third mock (driving the real `createStoreAdapter`) strictly needed `logicalType`;
  the other two feed `MockDataStore` paths that never call `resolvePkKeyCollations` —
  harmless and consistent either way.
- **Remote pk values are not run through `coerceRow`/`validateAndParse`** (unlike
  StoreTable's write path). Checked and judged no-action: sync records pk values from
  already-coerced local rows, so types match across replicas; pre-existing behavior,
  untouched by this fix, and adapter-completeness gaps are tracked by
  `external-row-change-ingestion` (plan/, confirmed present).
- **Error handling / resource cleanup**: per-table try/catch in the adapter maps
  failures to per-change `result.errors` — unchanged and correct; no new resources held.

### Found and fixed inline (minor)

- DRY'd the three identical hand-rolled e2e mock schemas in `sync-protocol-e2e.spec.ts`
  into a single `makeTestTableSchema()` factory typed as `TableSchema`, with a doc
  comment naming exactly which fields the sync paths read (extend there if the adapter
  reads more). Removed the six now-redundant `as unknown as import('@quereus/quereus')
  .TableSchema` inline-import casts at those call sites (the untyped `users` mocks keep
  theirs).
- Added a composite-PK mixed-collation regression test to
  `store-adapter-pk-collation.spec.ts`: `(a text collate binary, b integer, c text)` PK
  where the remote pk arrives case-flipped on the fallback-NOCASE member — proves the
  per-member resolution (declared BINARY / non-text undefined / fallback K) all line up
  with StoreTable's bytes for update and delete.
- Expanded the under-specified TSDoc on `SyncStoreAdapterOptions.collation` to state it
  is the table-level fallback K that must match the store module's configured collation,
  with per-column declared collations overriding it.

### Major findings

None — the fix is minimal, correct, and the parity is structural (shared function, same
fallback), not coincidental.

### Validation (review stage)

- `yarn workspace @quereus/sync run typecheck`: clean (run twice, after each edit batch).
- `yarn workspace @quereus/sync run test`: 168 passing, 0 failing (167 prior + 1 new
  composite-PK test).
- `yarn workspace @quereus/store run test`: 400 passing.
- `yarn workspace @quereus/quereus run lint`: clean.
- Root `yarn test` not re-run: implement stage ran it fully green at this code state;
  review edits are confined to quereus-sync tests + one TSDoc comment, covered by the
  workspace runs above (quereus core does not depend on @quereus/store or @quereus/sync).

## Known gaps (tracked elsewhere)

- The adapter maintains no secondary indexes, covering MVs, or watches on applied remote
  changes — pre-existing, tracked by `external-row-change-ingestion` (plan/).
- The regression spec runs only against `InMemoryKVStore`; key-byte construction is
  store-agnostic.
