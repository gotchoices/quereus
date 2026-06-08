description: Review the store-package implementation that persists views & materialized views in `__catalog__` (reserved-prefix keys), subscribes the SchemaChangeNotifier listener to view/MV lifecycle + tag events, and phases rehydration tables → views → MVs (MVs re-materialized via `db.exec`, dependency-ordered by fixpoint retry). Brings CREATE/DROP VIEW, CREATE/DROP MATERIALIZED VIEW, and ALTER VIEW|MATERIALIZED VIEW … SET/ADD/DROP TAGS to durable parity with tables.
prereq:
files:
  - packages/quereus-store/src/common/key-builder.ts            # buildViewCatalogKey / buildMaterializedViewCatalogKey / classifyCatalogKey / decodeMaterializedViewCatalogKey + reserved prefixes
  - packages/quereus-store/src/common/store-module.ts           # onEngineSchemaChange switch + save/remove view&MV DDL + enqueuePersist + loadCatalogEntries + rehydrateCatalog phasing + RehydrationResult
  - packages/quereus-store/src/common/index.ts                  # new key-builder exports + generateViewDDL/generateMaterializedViewDDL re-export
  - packages/quereus-store/test/view-mv-persistence.spec.ts     # NEW: 16 reopen round-trip cases (in-memory provider)
  - docs/schema.md                                              # tag-persistence note updated + new "View and materialized-view persistence" subsection
  - packages/quereus-store/README.md                            # catalog key namespaces + rehydrate phasing + key-helper table
----

# Review: persist views and materialized views for store-backed databases

## What landed

The generic store module now persists **views** and **materialized views** in
`__catalog__` and rehydrates them on reopen, reaching durable parity with tables
for `CREATE/DROP VIEW`, `CREATE/DROP MATERIALIZED VIEW`, and `ALTER VIEW|MATERIALIZED
VIEW … {SET|ADD|DROP} TAGS`. Store-package only; depends on the already-landed engine
ticket `view-mv-persistence-engine-support` (events + `generateViewDDL` /
`generateMaterializedViewDDL` + silent `importView`).

### Key namespaces (`key-builder.ts`)
- Table keys stay **unprefixed** (`{schema}.{table}`) — no re-keying, existing
  catalogs and the table full-scan are untouched.
- `buildViewCatalogKey` → `\x00view\x00{schema}.{view}`,
  `buildMaterializedViewCatalogKey` → `\x00mview\x00{schema}.{mv}`. A leading `0x00`
  byte can't appear in a table identifier key, so view/MV entries never collide with a
  same-named table entry (the engine actually enforces name-disjointness — verified —
  so a real collision can't be created, but the namespace is defensively distinct).
- `classifyCatalogKey(key)` routes a loaded entry to `'table' | 'view' |
  'materializedView'`; `decodeMaterializedViewCatalogKey` recovers `{schema}.{name}`
  for the rehydrate result (the MV re-exec path returns no name).
- `buildCatalogScanBounds()` (full range, `gte: []`, `lt: [0xff]`) returns the
  prefixed entries alongside tables — intended; rehydrate classifies them.

### Incremental persistence (`onEngineSchemaChange`)
Now a `switch` over the event union, all writes serialized on the existing
`persistQueue` via a new `enqueuePersist` helper (drained by `closeAll` /
`whenCatalogPersisted`):
- `view_added` / `view_modified` → `saveViewDDL` (compare-write, skip identical).
- `view_removed` → `removeViewDDL` (delete).
- `materialized_view_added` / `_modified` / `_refreshed` → `saveMaterializedViewDDL`.
- `materialized_view_removed` → `removeMaterializedViewDDL`.
- `table_modified` path is unchanged in behavior (kept its catalog-absent self-filter
  via `persistCatalogIfChanged`).

Unlike the table path there is **no** catalog-absent self-filter for view/MV
add/remove (one module ⇒ one Database). The MV **backing** table (`_mv_<name>`,
memory module) fires `table_added`/`table_removed`/`table_modified`; those stay
ignored, so the backing is never persisted.

**Design choice (compare-write for `*_added`):** the ticket table said plain `put`
for `_added`; I used the compare-write helper (`persistObjectCatalogEntryIfChanged`)
for adds too. It's a strict superset (still writes when absent/different) and makes a
rehydrate-time MV re-add a true no-op, which is what delivers the "idempotent second
reopen yields identical catalog bytes" guarantee. Documented in the helper.

### Subscription lifetime
`ensureSchemaSubscription(db)` is now also called from `rehydrateCatalog`, so any
reopened DB is subscribed up front (its first post-reopen statement may be a view/MV,
which never routes through a module hook).

### Rehydration phasing (`rehydrateCatalog`)
Load all entries once → classify by prefix → import in order:
1. **Tables** — `importCatalog` per entry (connect; refresh connected StoreTables).
2. **Views** — `importCatalog` per entry (engine silent-register; deferred body
   validation ⇒ view-over-view / view-over-MV order-independent; fires no event ⇒
   phase 2 writes nothing).
3. **Materialized views** — re-materialized via `db.exec(mvDDL)` per entry.

`RehydrationResult` gains additive `views` / `materializedViews` name arrays;
per-entry errors in any phase go to `errors` (non-fatal).

## ⚠️ Decisions & gaps the reviewer should scrutinize

1. **MV-over-MV ordering is a fixpoint retry, NOT the static topo sort the ticket
   sketched.** The ticket said to compare each pending MV's `sourceTables` against the
   others' `backingTableNameFor(name)` — but `sourceTables` (`_mv_<x>`) is computed at
   create time and is **not serialized in the DDL**, so it is unavailable before exec.
   Re-deriving it would require parsing each MV body and walking the AST for referenced
   relations (AGENTS.md discourages hand-rolled parsing). Instead: exec all pending
   MVs; an MV whose body reads a not-yet-built MV throws this round and succeeds once
   its dependency is built; repeat while any MV makes progress; when a round makes none,
   the remaining failures are genuine (missing source / cycle) and recorded in `errors`.
   - **Robust** to arbitrary nesting; covers single-level for free. Verified by a test
     where the *dependent* sorts first by key order (forcing a round-1 failure +
     round-2 success).
   - **Worst case O(N²) execs** for a deep linear MV chain (N MVs ⇒ up to N rounds).
     Acceptable for realistic catalogs; flagged, not optimized. The backlog ticket
     `store-mv-rehydrate-via-importcatalog` remains the place for a smarter MV import.
   - Reviewer: confirm a failed MV `db.exec` leaves no partial state that breaks the
     retry (the create emitter's catch cleans up backing + registration; tests pass,
     but this is the riskiest interaction).

2. **Subscription-before-first-table residual gap.** A brand-new DB that is **never
   rehydrated** and whose **very first** DDL is a `CREATE VIEW`/`CREATE MATERIALIZED
   VIEW` (no prior store-table create/connect) is not subscribed, so that first view/MV
   is not persisted. Documented in code + docs. Not fixed (would need an explicit
   public attach point); reviewer decides whether that ergonomic gap warrants a
   follow-up. Reopened DBs and DBs that create a store table first are unaffected.

3. **MV over a memory (non-persisted) source** re-materializes against an absent source
   on reopen → recorded in `errors`, MV not registered. Inherent to mixing memory
   sources into a durable catalog (same root cause as a plain view over a memory table,
   which silently registers but errors at query time). Documented, tested.

4. **Inherited engine gap — `backlog/view-body-rewrite-fires-no-schema-event`.** When
   `ALTER TABLE … RENAME` rewrites a dependent *view body* in place, the engine fires
   **no** event (filed during the engine ticket's review). So the store is never told
   to re-persist, and a reopen rehydrates a stale view body. Out of scope here (engine
   fix), but it is the one path where this ticket's persistence can silently go stale.

## Validation performed
- `yarn workspace @quereus/quereus build` — clean (engine exports consumed).
- `yarn workspace @quereus/store build` — clean.
- `yarn workspace @quereus/store test` — **346 passing** (16 new + 330 existing; no
  regressions). New spec `view-mv-persistence.spec.ts` covers: plain view reopen;
  view tags SET/ADD/DROP + SET()-clear; DROP VIEW durable; MV reopen (backing rebuilt
  + live row-time insert/update/delete maintenance); MV tags; DROP MV durable (MV +
  backing + entry gone); key-prefix distinctness; mixed tables+views+MVs classification;
  view-over-view & view-over-MV; MV-over-MV fixpoint (dependent-first); persist-queue
  drain (put-count = 2); idempotent second reopen (byte-identical catalog); REFRESH
  non-corruption; create-view-after-reopen subscription; MV-over-memory-source error.
- `yarn workspace @quereus/quereus lint` — clean (engine untouched; sanity only).
- `yarn workspace @quereus/plugin-leveldb build` + `… plugin-indexeddb build` — clean
  (additive `@quereus/store` API; downstream consumers read only `RehydrationResult.errors`).

## Known test-coverage floor (be adversarial here)
- **`yarn test:store` (LevelDB path) was NOT run for these cases.** The new reopen
  tests use the in-memory persistent provider (mirroring `tag-persistence.spec.ts` /
  `index-persistence.spec.ts`). The view/MV catalog writes go through the same generic
  `provider.getCatalogStore()` path the table catalog already exercises on LevelDB, so
  the byte-level round-trip is provider-agnostic — but a LevelDB-specific reopen of a
  view/MV catalog entry has not been exercised end-to-end. Worth a targeted LevelDB or
  IndexedDB reopen test if the reviewer wants belt-and-suspenders.
- The fixpoint retry's O(N²) bound and the cycle/`!progressed` branch are tested only
  via the 2-MV dependent-first case + the memory-source failure; a 3+ deep chain and a
  true cycle are not explicitly exercised.
- Tag-value fidelity for exotic values (blob/JSON tags) rides the engine generators'
  `tagValueToString` fallback (pre-existing limitation, not exercised here).
- No concurrency test for interleaved view/MV writes racing `closeAll` beyond the
  existing serialized-queue guarantees.
