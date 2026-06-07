description: Review the store secondary-index persistence implementation — each table's CREATE INDEX DDL is bundled into its `{schema}.{table}` catalog entry so indexes survive close→reopen, with index reattach-on-reopen, DML maintenance of rehydrated/partial indexes, and tag/DROP/RENAME round-trips. A scope-extension (partial-index DML predicate honoring in StoreTable.updateSecondaryIndexes) landed alongside; scrutinize it.
files:
  - packages/quereus-store/src/common/store-module.ts        # buildCatalogEntry, saveTableDDL, persistCatalogIfChanged, createIndex/dropIndex, rehydrateCatalog refresh
  - packages/quereus-store/src/common/store-table.ts         # markDdlSaved, compileIndexFor, partial-predicate honoring in updateSecondaryIndexes
  - packages/quereus/src/index.ts                            # export isHiddenImplicitIndex
  - packages/quereus-store/test/index-persistence.spec.ts    # new reopen test suite (11 cases)
  - docs/schema.md                                           # "Store catalog persistence (bundled index DDL)" section
----

# Review: persist store-backed secondary indexes across reconnect

## What the implement stage did

Bundled each table's secondary-index DDL into its existing `{schema}.{table}`
catalog entry (no new key namespace), so a `CREATE INDEX` / `CREATE UNIQUE INDEX`
/ partial index on a `using store` table survives `closeAll()` → reopen →
`rehydrateCatalog`. The bundle is `generateTableDDL` followed by one
`generateIndexDDL` line per persistable index, newline-joined; on reopen
`importCatalog`'s `parser.parseAll` splits it by AST (not on `\n`) and imports
table-before-indexes. This builds directly on the `index-ddl-roundtrip` prereq
(lossless `generateIndexDDL` + `importIndex` reconstruction).

### Changes

- **`store-module.ts`**
  - `buildCatalogEntry(tableSchema)` — new private helper: table DDL + each
    persistable index DDL (excludes `isHiddenImplicitIndex`), no-`db` form.
  - `saveTableDDL` now writes `buildCatalogEntry` (was bare table DDL). Every
    existing re-persist path (each `alterTable` arm, `renameTable`) therefore
    carries indexes for free.
  - `persistCatalogIfChanged` (the `table_modified` listener) compares/regenerates
    via `buildCatalogEntry` — so `ALTER INDEX … SET/ADD/DROP TAGS` (fires
    `table_modified` on the owning table) re-persists the changed index DDL with
    no index-specific code, and a structural ALTER / createIndex follow-up event
    stays a no-op (identical bundle → skip).
  - `createIndex` / `dropIndex` now call `await this.saveTableDDL(updatedSchema)`
    after `table.updateSchema(...)` (createIndex: the authoritative write that
    works even with zero rows; dropIndex: before physical teardown so a failed
    delete can't resurrect the index on reopen), then `table.markDdlSaved()`.
  - `rehydrateCatalog` — after the import loop, refreshes each connected
    `StoreTable`'s cached schema from `db.schemaManager.getTable(...)` (import
    updates the registry but not the live table instance; `importCatalog` skips
    module hooks by design, so the module reconciles here). Uses
    `table.getSchema().schemaName/name` (not a `tableKey.split('.')`).
- **`store-table.ts`**
  - `markDdlSaved()` — lets createIndex/dropIndex suppress the lazy
    first-store-access table-only save (`ddlSaved`), so exactly one catalog write
    per createIndex.
  - **Scope extension (scrutinize):** `updateSecondaryIndexes` now honors a
    partial index's `WHERE` predicate via a memoized `compileIndexFor` (mirrors
    the existing UNIQUE `compileFor` + `buildIndexEntries` build-time filtering).
    Before, the DML path added a backing entry for **every** row regardless of the
    predicate, so a persisted partial index was physically a full index. Both the
    add and remove halves are guarded, which also fixes scope transitions on
    UPDATE. This was *not* in the ticket TODO but is required for the ticket's
    "out-of-scope INSERT adds no index entry" expectation and is a latent
    correctness fix.
- **`quereus/src/index.ts`** — exports `isHiddenImplicitIndex` (was internal).

## Use cases / behavior to validate

Bare `StoreModule` over a persistent in-memory provider with `open()`/`reopen()`
(close→reopen against the same storage). Backing-index-store entry counts are
read from the provider's store map (one entry per indexed row).

- **plain CREATE INDEX**: created *before any rows*, then rows inserted →
  survives reopen; backing entries survive (reattach, not rebuild); a post-reopen
  INSERT grows the backing store; `where col = ?` returns the right rows.
- **CREATE UNIQUE INDEX**: `unique=1` round-trips; duplicate rejected, distinct
  accepted after reopen (derived `UNIQUE` enforces).
- **partial CREATE INDEX (WHERE)**: `partial=1`; only in-scope rows indexed at
  build; after reopen an out-of-scope INSERT adds no entry, in-scope does.
- **DESC + COLLATE**: `desc=1`, `collation=NOCASE` round-trip. NOTE: the index
  inherits the column's COLLATE — the live `CREATE INDEX` path rejects an inline
  per-column `COLLATE` (pre-existing engine limitation, see gaps).
- **multi-index table**: both indexes rehydrate, `result.errors` empty (bundle
  imports table-before-indexes).
- **DROP INDEX durable**: backing store gone immediately, bundle drops the line,
  absent after reopen.
- **DROP TABLE then reopen**: catalog entry gone, index store torn down, no
  resurrection.
- **RENAME TABLE then reopen**: index + data present under new name, old name
  gone (relies on provider `renameTableStores`).
- **ALTER INDEX SET/ADD/DROP TAGS**: tags round-trip via `index_info` after
  reopen.
- **inline UNIQUE + separate CREATE INDEX**: both survive; inline UNIQUE
  round-trips via table DDL and is NOT doubled as a `CREATE INDEX` line.
- **no double-write**: put-count spy shows exactly one catalog write for a
  CREATE INDEX (createIndex write + identical listener skip).

## Validation performed

- `yarn workspace @quereus/store test` → **328 passing** (incl. the 11 new cases).
- `yarn workspace @quereus/quereus test` → **5166 passing**, 9 pending (engine
  unaffected; only an additive export changed).
- `yarn build` (full monorepo) → clean. `yarn workspace @quereus/store typecheck`
  → clean. `yarn workspace @quereus/quereus lint` → clean.
- Not run: `yarn test:store` (LevelDB store-path logic suite) — the new behavior
  is validated against the in-memory store provider; a reviewer preparing a
  release may want to spot-check the LevelDB path, especially `renameTableStores`
  for indexes (the LevelDB provider implements it; **indexeddb does not** — see
  gaps).

## Known gaps / reviewer focus

- **Partial-index DML honoring is a behavior change** (`updateSecondaryIndexes`).
  No existing store test exercised partial-index DML, and the full suite passes,
  but confirm the add/remove guard logic is what you want (esp. UPDATE
  transitions across the predicate scope). Today the store's `query()` does not
  use secondary indexes for scans (full-scan + `matchesFilters`), so physical
  index *content* does not affect query results yet — the change matters for
  backing-store fidelity and for when index scans land.
- **IndexedDB `renameTableStores` is unimplemented** — `StoreModule.renameTable`
  no-ops the physical relocation there, so RENAME on the indexeddb backend would
  lose the index (and data) directories. Pre-existing provider gap, out of scope,
  but the bundle now makes the *catalog* side of RENAME correct, widening the
  surface where the provider gap is observable. Consider a follow-up.
- **Inline-COLLATE on `CREATE INDEX`** rejected by the live `buildIndexSchema`
  (`Indices on expressions are not supported`). Collation reaches an index only
  via column inheritance. The persisted DDL still emits explicit `COLLATE` and
  import unwraps it — the round-trip is fine — but the asymmetry (can persist a
  collation you can't directly declare on the index) is worth a glance.
- **IsolationModule-wrapped persistence is out of scope** (tests use a bare
  `StoreModule`, mirroring the tag/rehydrate specs).
- **Best-effort durability** — a catalog write failing after the physical index
  store is built leaves an in-memory-only index (missing + orphaned on reopen).
  Documented; no two-phase protocol added (matches the existing contract).
- **Test provider vs real stats** — the in-memory test provider uses a per-table
  `__stats__` store; real providers use a unified one. Stats are advisory and not
  central to this ticket, but the RENAME test does not assert stats relocation.
