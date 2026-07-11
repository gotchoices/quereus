----
description: Table, view, and column names that contain a broken half-character used to get silently mixed up together when a persistent database saved them, so creating two differently-named tables could lose one of them and saved table definitions could come back changed. The store now refuses such names with a clear error instead.
files:
  - packages/quereus-store/src/common/encoding.ts       # findUnpairedSurrogate (now exported) / assertNoUnpairedSurrogate (renamed + generalized from assertEncodableText)
  - packages/quereus-store/src/common/index.ts           # re-exports assertNoUnpairedSurrogate + findUnpairedSurrogate
  - packages/quereus-store/src/common/key-builder.ts     # buildCatalogKey / buildViewCatalogKey / buildMaterializedViewCatalogKey / buildStatsKey now guard identifiers via a private assertKeyableIdentifiers(...names) helper
  - packages/quereus-store/src/common/store-module.ts    # new private encodeCatalogDDL(ddl) helper, used by saveTableDDL / persistObjectCatalogEntryIfChanged / persistCatalogIfChanged
  - packages/quereus-store/test/lone-surrogate-keys.spec.ts   # new describe block: "an identifier or persisted DDL text carrying a lone surrogate"
  - packages/quereus-store/test/encoding.spec.ts         # new describe block for the exported assertNoUnpairedSurrogate/findUnpairedSurrogate
  - packages/quereus-store/test/key-builder.spec.ts      # new cases on buildCatalogKey/buildViewCatalogKey/buildMaterializedViewCatalogKey/buildStatsKey
  - packages/quereus-sync/src/metadata/keys.ts           # buildColumnVersionKey / buildTombstoneKey / buildSchemaMigrationKey / buildChangeLogKey / buildQuarantineKey / buildBasisLifecycleKey now guard identifier args via a local assertKeyableIdentifiers(...names) helper, imports assertNoUnpairedSurrogate from @quereus/store
  - packages/quereus-sync/test/metadata/keys.spec.ts     # new cases on buildChangeLogKey and buildColumnVersionKey
  - docs/store.md                                        # "Identifiers are not yet guarded" paragraph updated to describe the shipped behavior
----

# Review: catalog keys and DDL text now refuse identifiers with an unpaired surrogate

## What landed

Generalized the value-side guard from `bug-store-lone-surrogate-key-collision` into one shared,
exported primitive and wired it into every identifier/DDL-text write site the parent ticket
scoped in:

- `findUnpairedSurrogate` (offset scan) is now exported from `encoding.ts`. `assertEncodableText`
  was renamed to `assertNoUnpairedSurrogate(value, describe)` — same scan and error shape, but
  `describe` is now a caller-supplied phrase (`'a text value'`, `'the identifier "…"'`,
  `'persisted schema text'`) instead of a hardcoded "a text value". `encodeText`'s call site
  updated accordingly; behavior for TEXT values is unchanged (same message for the `'a text
  value'` case).
- `key-builder.ts`: `buildCatalogKey`, `buildViewCatalogKey`, `buildMaterializedViewCatalogKey`,
  `buildStatsKey` each now call a private `assertKeyableIdentifiers(...names)` helper (which just
  loops `assertNoUnpairedSurrogate` per identifier) before encoding. The stale `NOTE:` pointing at
  this ticket on `buildCatalogKey` is gone.
- `store-module.ts`: a new private `encodeCatalogDDL(ddl: string): Uint8Array` guards the FULL
  persisted DDL text (not just the object's name) and is now the only place any of the three
  DDL-persist sites (`saveTableDDL`, `persistObjectCatalogEntryIfChanged`,
  `persistCatalogIfChanged`) turn a DDL string into bytes. This catches a lone surrogate in a
  quoted **column** name or a `default '…'` / `check` string literal even when the table's own
  name is clean — verified by a dedicated test (see below).
- `quereus-sync/src/metadata/keys.ts`: all six identifier-keyed builders
  (`buildColumnVersionKey`, `buildTombstoneKey`, `buildSchemaMigrationKey`, `buildChangeLogKey`,
  `buildQuarantineKey`, `buildBasisLifecycleKey`) guard their `schemaName`/`tableName`/`column`
  arguments via a local `assertKeyableIdentifiers` helper, importing `assertNoUnpairedSurrogate`
  from `@quereus/store` (already a dependency). The `pk`/`hlc`/`entryType` components are exempt —
  `encodePK` already routes through `JSON.stringify`, which escapes a lone surrogate to ASCII.

The fix is **unconditional refuse**, not collision detection: an identifier carrying an unpaired
surrogate is rejected on its own, whether or not a colliding sibling identifier actually exists.
This mirrors the value-side ticket's own design decision and is simpler than trying to detect the
collision after the fact.

## How to validate / use-case coverage

Direct exercises of the fix, all passing:

- **Catalog-key collision (the ticket's own repro)** — `lone-surrogate-keys.spec.ts`: two tables
  named `"\uD800"` and `"\uD801"` (differ only in a lone surrogate) — creating both succeeds (no
  eager catalog write on `CREATE TABLE`), but the first `INSERT`/`SELECT` against **either** table
  raises (DDL persistence is lazy, on first store access — see `StoreTable.initializeStore`).
  Confirms neither silently clobbers the other and nothing is left half-written
  (`loadAllDDL()` returns `[]` after the rejection).
- **A direct, non-lazy save path** — `create index … on "\uD800" (…)` raises too (`createIndex`
  awaits `saveTableDDL` directly, not through the lazy-init path).
- **DDL-text corruption, not just the table name** — a lone surrogate in a quoted **column** name,
  and separately in a `default '…'` string literal, each raise at first data access even though
  the table's own name is unicode-clean. This is the "invisible half" of the bug the parent ticket
  called out (silent schema-text mangling with no `UNIQUE`-shaped symptom).
- **Unit-level coverage** for every guarded builder: `key-builder.spec.ts` (`buildCatalogKey`,
  `buildViewCatalogKey`, `buildMaterializedViewCatalogKey`, `buildStatsKey`) and
  `keys.spec.ts` in `quereus-sync` (`buildChangeLogKey`, `buildColumnVersionKey`).
- `encoding.spec.ts` unit-tests the exported `assertNoUnpairedSurrogate`/`findUnpairedSurrogate`
  directly: accepts clean strings, raises naming the code unit + offset, and interpolates the
  caller's `describe` phrase into the message.

Test/build commands run this pass, all green:
- `node --import ./packages/quereus-store/register.mjs .../mocha.js "packages/quereus-store/test/**/*.spec.ts"` — **938 passing**
- `node --import ./packages/quereus-sync/register.mjs .../mocha.js "packages/quereus-sync/test/**/*.spec.ts"` — **477 passing**
- `yarn build` (full monorepo, all packages + bundled apps) — clean
- `tsc -p tsconfig.test.json --noEmit` in both `quereus-store` and `quereus-sync` (test-file type
  checking; neither package's `lint` script does this itself, only `@quereus/quereus`'s does) — clean
- No pre-existing failures encountered; nothing was skipped or loosened.

## Known gaps — read before treating this as done

1. **Views and materialized views: the guard fires but the error never reaches the caller.**
   Empirically verified (throwaway script, not committed): `create view "\uD800" as select …`
   does **not** throw — `CREATE VIEW` returns successfully, the view is queryable in-session, but
   its catalog write is silently dropped. Root cause: `view_added`/`materialized_view_added`
   schema-change events route through `StoreModule.enqueuePersist`, which wraps the async persist
   work in `.catch(err => console.warn(...))` — **by design**, so that a listener failure can never
   abort the SQL statement that triggered it (see the doc comment on `enqueuePersist`). That
   swallow is pre-existing and applies to every persist failure on that path, not something
   specific to this fix — but it means `buildViewCatalogKey`/`buildMaterializedViewCatalogKey`'s
   new guard is only exercised at the unit level here (`key-builder.spec.ts`), not through an
   integration test asserting `db.exec('create view ...')` rejects, because it provably does not
   reject. A close → reopen after such a `CREATE VIEW` would silently lose the view (with a
   `console.warn`), same as any other advisory-persist failure on that path today.
   **This is a real, currently-reachable gap** (not a "some day, if X" tripwire) — flagging for the
   reviewer to decide whether it's in-scope to fix here (e.g. making `CREATE VIEW`/`CREATE
   MATERIALIZED VIEW` validate the identifier synchronously before persisting, mirroring how a
   plain `CREATE TABLE` at least fails on first data access) or worth its own ticket. I did not
   attempt a fix — it touches the `enqueuePersist`/event-dispatch architecture, which is
   IMO beyond "the same one-line fix" this ticket was scoped as.
2. **`buildDataStoreName`/`buildIndexStoreName` remain unguarded** (out of the parent ticket's
   explicit scope — it named only `buildCatalogKey`/`buildViewCatalogKey`/
   `buildMaterializedViewCatalogKey`/`buildStatsKey`). These build the **physical store name**
   string (`{schema}.{table}`, `{schema}.{table}_idx_{index}`) used as a `Map` key for the
   in-memory/test provider (safe — JS string equality distinguishes lone surrogates fine) but
   handed to real providers (LevelDB, IndexedDB) as a raw string that likely becomes a directory
   or object-store name. Whether a *real* provider's own encoding folds two lone-surrogate-differing
   names to one physical location is unverified here — I did not test against LevelDB/IndexedDB.
   If it does, two tables differing only by a lone surrogate could still collide at the storage
   layer even though their *catalog* keys are now safely distinct. Not investigated further;
   flagging as a possible latent gap for the reviewer to scope.
3. **Rejection timing for tables is lazy, not at `CREATE TABLE`.** `saveTableDDL` runs on first
   store access (`StoreTable.initializeStore`), not inside `create()`. So `create table "\uD800"
   (...) using store` succeeds; the first `insert`/`select` against it is what raises. This matches
   the parent ticket's own TODO framing ("work backward from where … actually called … to confirm
   the error propagates") and is consistent with how `CREATE INDEX`/`ALTER TABLE` persist (direct
   await, propagates normally) — just noting it explicitly since it differs from what a reader
   might assume ("rejected at CREATE TABLE time").

## Empty categories

No pre-existing test failures were hit. No tests were skipped, loosened, or disabled.
