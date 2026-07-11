---
description: Table, view, and column names that contain a broken half-character currently get silently mixed up together when a persistent database saves them, so creating two differently-named tables can lose one of them and saved table definitions can come back changed. This makes the store refuse such names with a clear error instead.
files:
  - packages/quereus-store/src/common/encoding.ts       # findUnpairedSurrogate / assertEncodableText — export a shared, reusable guard
  - packages/quereus-store/src/common/index.ts           # re-export the new guard so quereus-sync can import it
  - packages/quereus-store/src/common/key-builder.ts     # buildCatalogKey / buildViewCatalogKey / buildMaterializedViewCatalogKey / buildStatsKey
  - packages/quereus-store/src/common/store-module.ts    # saveTableDDL / persistObjectCatalogEntryIfChanged / persistCatalogIfChanged — DDL text encode sites
  - packages/quereus-store/test/lone-surrogate-keys.spec.ts   # sibling spec — mirror its structure for identifiers
  - packages/quereus-store/test/encoding.spec.ts         # `unpaired surrogates` describe block — add the exported-guard unit tests here
  - packages/quereus-sync/src/metadata/keys.ts           # buildColumnVersionKey / buildTombstoneKey / buildSchemaMigrationKey / buildChangeLogKey / buildQuarantineKey / buildBasisLifecycleKey
  - packages/quereus-sync/test/metadata/keys.spec.ts      # add identifier-guard coverage alongside existing key-builder tests
  - docs/store.md                                        # "Identifiers are not yet guarded" paragraph (lines ~625-627) — update once fixed
difficulty: easy
---

# Catalog keys and DDL text must refuse identifiers with an unpaired surrogate

## Confirmed reproduction

Added a throwaway spec against `StoreModule` directly (not committed — deleted after
confirming), equivalent to:

```ts
const db1 = new Database();
db1.registerModule('store', new StoreModule(provider));
await db1.exec(`create table "\uD800" (k integer primary key) using store`);
await db1.exec(`insert into "\uD800" values (1)`);
await db1.exec(`create table "\uD801" (k integer primary key) using store`);
await db1.exec(`insert into "\uD801" values (2)`);

const db2 = new Database();
const mod2 = new StoreModule(provider);
db2.registerModule('store', mod2);
const result = await mod2.rehydrateCatalog(db2);
// result.tables.length === 1, not 2 — the second CREATE TABLE clobbered the first's
// catalog entry, and rehydrateCatalog silently returns only one table with no error.
```

Ran under `packages/quereus-store`'s mocha harness — `result.tables` has length **1**, not
**2**. The lexer accepts a raw lone surrogate inside a double-quoted identifier
(`doubleQuotedIdentifier` in `packages/quereus/src/parser/lexer.ts` takes the quoted span as
a raw `source.substring(...)`, no validation), so this is reachable from ordinary SQL text,
not just the programmatic schema APIs.

## Root cause

`buildCatalogKey` (and its view / materialized-view / stats-key siblings) in
`packages/quereus-store/src/common/key-builder.ts` build a catalog key by running the
qualified `schema.table` string straight through `TextEncoder`. `TextEncoder` silently
replaces every unpaired surrogate with `U+FFFD` (bytes `EF BF BD`) — so any two identifiers
that differ only in *which* lone surrogate they carry produce the identical key bytes, and
the second `CREATE TABLE`'s DDL write overwrites the first's.

The companion defect: `StoreModule.saveTableDDL` (and the two other DDL-persisting call
sites, `persistObjectCatalogEntryIfChanged` and `persistCatalogIfChanged`, all in
`store-module.ts`) encode the *entire* reconstructed `create table …` text — not just the
table name — through the same raw `TextEncoder`. A lone surrogate anywhere in that text
(a quoted column name, a `default '…'` string literal, a `check` constraint's string
constant) is folded to `U+FFFD` on write and decoded back as different schema text than what
was created. This has no `UNIQUE`-shaped symptom — it's silent corruption of the persisted
DDL, catchable only by comparing before/after text.

A third, structurally identical site: `packages/quereus-sync/src/metadata/keys.ts` builds
`cv:{schema}.{table}:{pk_json}:{column}`-shaped keys (`buildColumnVersionKey`,
`buildTombstoneKey`, `buildSchemaMigrationKey`, `buildChangeLogKey`, `buildQuarantineKey`,
`buildBasisLifecycleKey`) by interpolating raw schema/table/column names into a template
string and running the whole thing through `TextEncoder`. The `{pk_json}` component is safe
(`JSON.stringify` escapes lone surrogates to ASCII), but the identifier components are not.

## Prior art: the value-side fix

`bug-store-lone-surrogate-key-collision` (shipped, see `tickets/complete/2-bug-store-lone-surrogate-key-collision.md`)
fixed the same class of bug for TEXT column *values*: `encodeText` in
`packages/quereus-store/src/common/encoding.ts` now calls `assertEncodableText`, which uses
`findUnpairedSurrogate` to detect the defect and raises a `QuereusError` naming the offending
code unit and offset, rather than letting `TextEncoder` fold it. That review pass explicitly
identified this ticket's three sites as needing "the same one-line fix" but scoped them out
of that PR. `findUnpairedSurrogate` already exists and is proven correct (see that ticket's
review notes) — it is not exported yet, and `assertEncodableText`'s error message is
TEXT-value-specific ("cannot store a text value containing…").

## Fix shape

Refuse, matching the value-side decision already made and documented in the parent bug
ticket: an identifier (or DDL text) that is not valid Unicode has no business naming or
describing a durable object. Raise a `QuereusError` naming the offending code unit and
offset, at the point the schema mutation is persisted — not merely detected later at
rehydrate time.

Generalize the existing detector into one shared, exported guard so every write site (catalog
keys, DDL text, sync metadata keys) calls the same function instead of re-implementing the
scan or writing a divergent error message.

## TODO

### Shared detector

- In `packages/quereus-store/src/common/encoding.ts`, export `findUnpairedSurrogate` and add
  an exported `assertNoUnpairedSurrogate(value: string, describe: string): void` that raises
  the `QuereusError` (reusing the existing message shape — code unit + offset — but
  parameterized by what's being validated, e.g. `describe = 'a text value'` /
  `'the identifier "..."'` / `'persisted schema text'`). Refactor `assertEncodableText` to
  call it (`describe = 'a text value'`) so there is exactly one scan implementation and one
  message template.
- Re-export `assertNoUnpairedSurrogate` (and `findUnpairedSurrogate` if useful standalone)
  from `packages/quereus-store/src/common/index.ts` so `quereus-sync` — which already depends
  on `@quereus/store` — can import it rather than duplicating the scan.

### Catalog keys (`packages/quereus-store/src/common/key-builder.ts`)

- `buildCatalogKey`, `buildViewCatalogKey`, `buildMaterializedViewCatalogKey`,
  `buildStatsKey`: call `assertNoUnpairedSurrogate` on `schemaName` and the
  table/view/mv name before encoding. Remove the now-stale `NOTE:` comment on
  `buildCatalogKey` that points at this ticket (replace with nothing, or a short comment
  noting the guard, matching the style of `assertEncodableText`'s doc comment).
- Decide whether the check belongs in each `build*Key` function individually (simple, matches
  today's structure) or behind one shared internal helper the four functions call — prefer
  whichever avoids duplicating the two-argument call four times with different names; a
  small private `assertKeyableIdentifiers(schemaName, ...names)` helper is probably cleanest.

### DDL text (`packages/quereus-store/src/common/store-module.ts`)

- `saveTableDDL`, `persistObjectCatalogEntryIfChanged`, `persistCatalogIfChanged` each encode
  a full DDL string with `new TextEncoder().encode(ddl)` right before `catalogStore.put`.
  Introduce one private helper (e.g. `encodeCatalogDDL(ddl: string): Uint8Array`) that calls
  `assertNoUnpairedSurrogate(ddl, 'persisted schema text')` then encodes, and use it at all
  three sites — don't just fix `saveTableDDL` and miss the other two (this is exactly how the
  prior ticket's review caught the DDL-mangling defect that its own PR had missed).
  This guard fires on **any** unpaired surrogate anywhere in the generated DDL text
  (identifier or string literal), so a column name or a `default`/`check` literal carrying one
  is caught too — it doesn't rely on the catalog-key guard above to have already caught it via
  the table/schema name.

### Sync metadata keys (`packages/quereus-sync/src/metadata/keys.ts`)

- `buildColumnVersionKey`, `buildTombstoneKey`, `buildSchemaMigrationKey`,
  `buildChangeLogKey`, `buildQuarantineKey`, `buildBasisLifecycleKey`: guard the
  `schemaName`/`tableName`/`column` identifier arguments (not the `pk`/`hlc`/`entryType`
  components, which are already safe) with `assertNoUnpairedSurrogate` imported from
  `@quereus/store`, before building the key string.
- Import path: these build functions are called from several sync-internal modules
  (`change-applicator.ts`, `tombstones.ts`, `schema-migration.ts`, `quarantine.ts`,
  `column-version.ts`, `change-log.ts`, `basis-lifecycle.ts`) — the guard belongs inside the
  `keys.ts` builders themselves (one choke point), not at each call site.

### Tests

- `packages/quereus-store/test/lone-surrogate-keys.spec.ts` (or a new sibling spec, following
  its documented style): add a case creating two store-backed tables whose *names* differ only
  in a lone surrogate and asserting the second `create table` raises (naming the unpaired
  surrogate) instead of silently succeeding and clobbering the first's catalog entry on
  reopen. Cover the view and materialized-view catalog key builders too if they're reachable
  from SQL with a lone-surrogate name (check `create view "\uD800" as ...`).
  If the raise should surface at `CREATE TABLE` time (not merely inside `key-builder.ts`
  unit tests), work backward from where `buildCatalogKey`/`saveTableDDL` are actually called
  during DDL execution to confirm the error propagates out of `db.exec(...)` — mirror
  `lone-surrogate-keys.spec.ts`'s `rejects()` helper.
- Add a DDL-text-mangling case: a table with a **column name** or a `default '...'` literal
  carrying a lone surrogate must raise at create/persist time, not silently store mangled
  schema text that reads back differently on reopen.
- `packages/quereus-store/test/encoding.spec.ts`: unit-test the new exported
  `assertNoUnpairedSurrogate` directly (accepts a clean string, raises on an unpaired
  surrogate, message names the code unit/offset) alongside the existing
  `assertEncodableText`/`findUnpairedSurrogate` coverage.
- `packages/quereus-sync/test/metadata/keys.spec.ts`: add cases for at least one of the guarded
  builders (e.g. `buildColumnVersionKey`) confirming it raises rather than building a key.

### Docs

- `docs/store.md` lines ~625-627 ("Identifiers are **not** yet guarded…") — once the fix
  lands, update this paragraph to describe the shipped behavior (mirroring how the parent
  ticket's review updated the same file's collation/`orderPreserving` section) and drop the
  reference to this ticket.
