description: Persist store-backed secondary indexes across reconnect — each table's CREATE INDEX DDL is bundled into its `{schema}.{table}` catalog entry so indexes survive close→reopen, with reattach-on-reopen, DML maintenance of rehydrated/partial indexes, and tag/DROP/RENAME round-trips. A scope-extension honoring partial-index DML predicates in StoreTable.updateSecondaryIndexes landed alongside.
files:
  - packages/quereus-store/src/common/store-module.ts        # buildCatalogEntry, saveTableDDL, persistCatalogIfChanged, createIndex/dropIndex, rehydrateCatalog refresh
  - packages/quereus-store/src/common/store-table.ts         # markDdlSaved, compileIndexFor, partial-predicate honoring in updateSecondaryIndexes
  - packages/quereus/src/index.ts                            # export isHiddenImplicitIndex
  - packages/quereus-store/test/index-persistence.spec.ts    # reopen test suite (now 13 cases)
  - docs/schema.md                                           # "Store catalog persistence (bundled index DDL)" section
----

# Persist store-backed secondary indexes across reconnect

## What shipped

Each `using store` table's secondary-index DDL is bundled into its existing
`{schema}.{table}` catalog entry — `generateTableDDL` followed by one
`generateIndexDDL` line per persistable index (hidden implicit covering indexes
excluded), newline-joined. On reopen, `importCatalog`'s `parser.parseAll` splits
the bundle AST-by-AST (never on `\n`) and imports table-before-indexes. Because
indexes ride the table's own entry, every existing re-persist path —
`saveTableDDL` (each `alterTable` arm, `renameTable`), the `table_modified`
listener, and `removeTableDDL` — carries or drops them for free.

Key pieces:
- `buildCatalogEntry` builds the bundle; `saveTableDDL` / `persistCatalogIfChanged`
  use it, so structural ALTERs, RENAME, and `ALTER INDEX … SET TAGS` re-persist
  index DDL with no index-specific plumbing, and identical-bundle writes skip.
- `createIndex` / `dropIndex` eagerly write the bundle (createIndex: authoritative
  even with zero rows; dropIndex: before physical teardown) then `markDdlSaved()`
  so the lazy first-access table-only save is suppressed → exactly one catalog
  write per createIndex.
- `rehydrateCatalog` refreshes each connected `StoreTable`'s cached schema from
  the registry after import (import updates the registry but not the live
  instance), so DML maintains rehydrated indexes and derived UNIQUE enforces.
- **Scope extension:** `StoreTable.updateSecondaryIndexes` now honors a partial
  index's `WHERE` predicate (memoized `compileIndexFor`), guarding both the
  add and remove halves so a row crossing the predicate scope on UPDATE is
  maintained correctly. Backing index content is now a true partial index, not
  physically full.
- `isHiddenImplicitIndex` exported from `@quereus/quereus`.

The physical index KV store survives a logical close, so rehydrate reattaches
(lazily via `provider.getIndexStore`) rather than rebuilding.

## Review findings

**Read first:** the implement diff (`git show 7b61474e`) before the handoff, then
cross-checked against `buildIndexEntries`, `initializeStore`/`ddlSaved`,
`persistCatalogIfChanged`, `onEngineSchemaChange`, `isHiddenImplicitIndex`, and
both provider implementations of `renameTableStores`.

### Checked — no issue

- **Bundle / no-double-write invariant.** `buildCatalogEntry` excludes
  `isHiddenImplicitIndex` (defensive — store tables synthesize no implicit
  covering index for an inline UNIQUE; the inline-UNIQUE test confirms exactly
  one `CREATE INDEX` line, no doubling). `CREATE UNIQUE INDEX`'s derived UNIQUE is
  excluded from the table DDL by the generator, so it round-trips solely via its
  own index line. The createIndex eager write + identical follow-up listener skip
  is verified by the put-count spy test (exactly 1 write).
- **`markDdlSaved` ordering.** createIndex/dropIndex write the bundle then mark
  saved; a later INSERT's lazy `initializeStore` save is correctly suppressed, so
  the bundle (with/without the index) is never clobbered by table-only DDL.
- **Rehydrate schema refresh.** Refreshing live `StoreTable` instances from
  `db.schemaManager.getTable(...)` post-import (not a `tableKey.split`) is correct
  and necessary — without it, rehydrated tables would not maintain indexes nor
  enforce derived UNIQUE.
- **Partial-predicate three-valued logic.** DML uses `predicate.evaluate(row) ===
  true` (include); build uses `!== true` (skip) — semantically equivalent. The
  remove half is guarded too, so a DELETE / out-of-scope UPDATE of a row that was
  never indexed issues no spurious delete.
- **Memoization.** `indexPredicateCache` is a `WeakMap` keyed on the frozen
  IndexSchema identity, mirroring `predicateCache`; a CREATE/DROP/reopen produces
  a fresh object so retired entries are GC-reclaimed. No `any`; typecheck clean.
- **Docs.** `docs/schema.md` "Store catalog persistence (bundled index DDL)"
  accurately reflects the bundle format, reattach-not-rebuild, the re-persist
  paths, partial-index DML honoring, and best-effort durability.

### Minor — fixed in this pass

- **Missing UPDATE-path test coverage.** The implementer's 11 cases exercised
  only INSERT-driven index growth; the new partial-index DML guard and
  full-index entry relocation on UPDATE — the scope extension flagged for
  scrutiny — were untested. Added two cases to
  `packages/quereus-store/test/index-persistence.spec.ts` (now 13), both against
  the *rehydrated* index to also cover the post-reopen predicate-cache path:
  - full-index UPDATE re-keys the single backing entry without leaking the old
    key (count stays 1; old value no longer queryable, new value is);
  - partial-index UPDATE across the predicate scope both ways
    (in→out drops the entry, out→in re-adds it, in→in stays one).
  Both pass. `yarn workspace @quereus/store test` → **330 passing**.

### Major — new ticket filed

- **IndexedDB `RENAME TABLE` data loss** →
  `tickets/backlog/indexeddb-rename-table-stores-data-loss.md`. The indexeddb
  provider does not implement `renameTableStores`, so `StoreModule.renameTable`
  no-ops the physical relocation (the `if (this.provider.renameTableStores)`
  guard) while still rewriting the catalog under the new name — on reopen the
  table + indexes rehydrate but open fresh empty object stores, orphaning the
  original rows/entries. Pre-existing for table data; this ticket widens the
  surface to indexes. LevelDB and the in-memory test provider implement rename
  correctly. Cannot be fixed inline (needs an indexeddb relocation strategy —
  object-store names are fixed at `upgradeneeded`), so filed for the maintainer.

### Out of scope / accepted (documented gaps confirmed, not findings)

- **Inline-COLLATE on `CREATE INDEX`** rejected by live `buildIndexSchema`;
  collation reaches an index only via column inheritance. The persisted DDL emits
  explicit `COLLATE` and import unwraps it, so the round-trip is intact — the
  persist-vs-declare asymmetry is a pre-existing engine limitation, not a defect
  in this work.
- **IsolationModule-wrapped persistence** untested (bare `StoreModule`, mirroring
  the tag/rehydrate specs) — consistent with existing coverage.
- **Best-effort durability** — a catalog write failing after the physical index
  store is built leaves an in-memory-only index; no two-phase protocol, matching
  the store's existing contract. Documented.
- **Query path does not yet use secondary indexes** (full-scan + `matchesFilters`),
  so physical index content does not affect query results today — the
  partial-index DML fix matters for backing-store fidelity and for when index
  scans land.

## Validation

- `yarn workspace @quereus/store test` → **330 passing** (was 328; +2 review
  cases). `yarn workspace @quereus/store typecheck` → clean.
- Engine package unchanged except the additive `isHiddenImplicitIndex` export
  (implement stage: 5166 passing, 9 pending). The store package has no lint
  script; the review change is confined to the store test file.
- Not run: `yarn test:store` (LevelDB logic suite) — behavior validated against
  the in-memory provider, consistent with the implement stage; a release prep
  may spot-check the LevelDB `renameTableStores` index path.
