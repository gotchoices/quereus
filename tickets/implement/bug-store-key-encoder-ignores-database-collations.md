----
description: When an application teaches the database its own text-sorting rule, the persistent store still lays out its keys using a built-in rule, so two values the application considers identical can be stored as two separate primary-key rows; make the store use the application's rule and raise a clear error when a rule cannot be used for keys.
files:
  - packages/quereus-store/src/common/encoding.ts        # collationEncoders registry to delete; encodeText/encodeObject take a resolver
  - packages/quereus-store/src/common/store-table.ts     # resolvePkKeyCollations(); encodeOptions; three getCollationEncoder guards (~903, ~1001, ~1903)
  - packages/quereus-store/src/common/store-module.ts    # getCollationEncoder guard (~2059); resolveKeyNormalizer sites (~1001, ~1119); buildIndexEntries / rebuildSecondaryIndexes / validateUniqueOverExistingRows
  - packages/quereus-store/src/common/index.ts           # re-exports registerCollationEncoder / getCollationEncoder / CollationEncoder
  - packages/quereus-store/src/common/key-builder.ts     # EncodeOptions passthrough (no logic change expected)
  - packages/quereus/src/core/database.ts                # getKeyNormalizerResolver() (~1497); _getCollationNormalizer() (~1529)
  - packages/quereus/src/core/database-internal.ts       # add _getCollationNormalizer to the internal facade
  - packages/quereus/src/util/key-serializer.ts          # resolveKeyNormalizer — delete once the store stops calling it; BUILTIN_NORMALIZERS stays
  - packages/quereus/src/index.ts                        # stop exporting resolveKeyNormalizer; export BUILTIN_NORMALIZERS
  - packages/quereus/test/collation-normalizer.spec.ts   # imports resolveKeyNormalizer
  - packages/quereus/test/util/json-canonical.spec.ts    # imports resolveKeyNormalizer
  - packages/quereus-store/test/encoding.spec.ts         # asserts getCollationEncoder / registerCollationEncoder
  - packages/quereus-store/test/custom-collation.spec.ts # sibling suite; add the PK-key cases here or in a new spec
  - docs/sql.md                                          # § COLLATE "Store caveat — physical key bytes" (~2558) — delete when this lands
  - docs/schema.md, docs/plugins.md                      # store-collation notes mentioning the comparator-only residual
difficulty: medium
----

# Store key encoding must resolve collations against the database

## Reproduced on current `main`

```ts
const db = new Database();
db.registerCollation('NOCASE', noSpace, (s) => s.replace(/ /g, ''));  // 'a b' == 'ab'
db.registerModule('store', new StoreModule(provider));

await db.exec(`create table t (k text collate NOCASE primary key, v text) using store`);
await db.exec(`insert into t values ('a b', 'one')`);
await db.exec(`insert into t values ('ab',  'two')`);   // expected: UNIQUE constraint failed
```

Observed: second insert succeeds, `select count(*) from t` returns `2`. The table holds a
duplicate primary key. `encodeText` normalized both values with the *built-in* lowercase
NOCASE encoder, so they landed at different key bytes.

The second reproduction the original ticket asked about — an **unregistered** name on a PK
column — is already unreachable through `CREATE TABLE`:

```
Unknown collation 'NOSPACE' for type 'TEXT' on column 'k' (expected one of: BINARY, NOCASE, RTRIM)
```

`validateCollationForType` rejects it before the store sees it. So today the only ways a
non-built-in normalizer reaches store key encoding are (a) overriding a built-in name on the
connection, as above, and (b) the table-level key collation `K` passed as
`using store(collation = '…')`, which is not validated against anything. Both must be fixed;
the DDL-time error for (a)'s sibling — a *custom-named* column collation — arrives with
`backlog/feat-ddl-accepts-registered-collations`, and this fix must already be correct when
it does.

## Root cause

`packages/quereus-store/src/common/encoding.ts` holds a **process-global** map from collation
name to a `CollationEncoder` (`{ encode(s: string): string }`), seeded with exactly `BINARY`
(identity), `NOCASE` (`toLowerCase`), and `RTRIM` (`replace(/\s+$/, '')`). `encodeText` and
`encodeObject` look a name up there and fall back to the NOCASE encoder on a miss. The
database's own per-connection registry — `Database.registerCollation(name, comparator,
{ normalizer })` — is never consulted, so the physical key layout and every value comparison
`StoreTable` makes (which *do* go through `db.getCollationResolver()`, per the landed
`3.4-store-isolation-collation-resolver`) can disagree about which rows are the same row.

A `CollationEncoder` and a `KeyNormalizer` are the same thing under two names: a
`(s: string) => string` whose output equality partitions strings exactly as the comparator
does. The engine already has the type (`KeyNormalizerResolver`), the registry
(`Database.collations`), and the resolver with a no-silent-fallback contract
(`Database.getKeyNormalizerResolver()`, added by `bug-key-normalizer-ignores-database-collations`).
The store just isn't wired to it.

## Design

### 1. The encoder registry goes away; `EncodeOptions` carries a resolver

Delete `CollationEncoder`, `registerCollationEncoder`, `getCollationEncoder`, the three
built-in encoder constants, and the `collationEncoders` map from `encoding.ts` (and their
re-exports from `common/index.ts` — a public API break, which AGENTS.md waives).

`EncodeOptions` grows one field:

```ts
export interface EncodeOptions {
  /** Collation name for TEXT/OBJECT values. Default: 'NOCASE'. */
  collation?: string;
  /**
   * Resolves a collation name to the string normalizer that produces its key bytes.
   * Supply `db.getKeyNormalizerResolver()` so key bytes and value comparisons agree
   * on which strings are the same value. Defaults to `BUILTIN_KEY_NORMALIZER_RESOLVER`
   * (BINARY / NOCASE / RTRIM only; throws on any other name).
   */
  normalizers?: KeyNormalizerResolver;
}
```

`encodeText` / `encodeObject` become
`(options.normalizers ?? BUILTIN_KEY_NORMALIZER_RESOLVER)(collation)` — **no `?? NOCASE`
fallback anywhere.**

`BUILTIN_KEY_NORMALIZER_RESOLVER` lives in `encoding.ts` and is built from the engine's
exported `BUILTIN_NORMALIZERS`, not from a second local copy of the three functions. Do not
reintroduce a store-local RTRIM.

### 2. Byte-compatibility: `RTRIM` deliberately changes for non-space whitespace

`BINARY` and `NOCASE` are byte-identical before and after (identity, `toLowerCase`).

`RTRIM` is **not**, and that is the point. The store's encoder strips `/\s+$/` (tabs,
NBSP, every Unicode space); the engine's `RTRIM_NORMALIZER` — and `RTRIM_COLLATION`, the
comparator the store's own UNIQUE enforcement uses — strip only ASCII `0x20`. So today
`'a\t'` and `'a'` encode to the *same* store key while the comparator calls them different
values: a distinct-under-RTRIM row can be silently clobbered by its neighbour. Adopting the
engine's normalizer fixes that. Any persisted RTRIM-keyed row whose key ends in non-space
whitespace changes key bytes; backwards compatibility is waived project-wide.

Call this out in the review handoff — it is the one place where "the built-ins keep encoding
byte-identically" (the original ticket's constraint) is deliberately not honored, because
honoring it would preserve a bug.

### 3. Where the resolver enters

`StoreTable` already holds `db` and binds `this.collationResolver = db.getCollationResolver()`
in its constructor. Bind the sibling there and fold it into the options object built one line
below, so every `buildDataKey` / `buildIndexKey` / `encodePkPrefixBounds` call site inherits
it with no signature change:

```ts
this.encodeOptions = {
  collation: config.collation || 'NOCASE',
  normalizers: db.getKeyNormalizerResolver(),
};
```

`StoreModule.buildIndexEntries` builds its own `{ collation: keyCollation }` (store-module.ts
~984) for the index rebuild path. It must get the same resolver, or an `ALTER`-driven rebuild
will re-encode the PK suffix under different bytes than `StoreTable` writes at maintenance
time — a silently corrupt index. `createIndex` has `db` in scope; `rebuildSecondaryIndexes`
does not but its two `alterTable` callers do. Thread a `KeyNormalizerResolver` (not the whole
`Database`) down into `buildIndexEntries`.

### 4. Validate at DDL time, not at first write

A collation with a comparator but no normalizer (`db.registerCollation(name, cmp)` with no
third argument) cannot key a persisted structure. An unregistered name cannot either. Both
must raise where a human can act on it.

Do the check in `StoreTable`'s constructor and in `updateSchema` (both already call
`resolvePkKeyCollations`), over exactly the collations the table's key encoding will actually
use — not over every name in the schema:

- every defined entry of `pkKeyCollations` (these exist only for text-capable PK columns, by
  construction);
- the table key collation `K` (`config.collation`), but only if the table has at least one
  secondary index (index-column bytes are encoded under `K`, per `buildIndexKey`) — a table
  with an integer PK and no indexes never encodes text and must not be made unopenable by a
  collation it doesn't use.

For each, probe `db._getCollationNormalizer(name)`; raise `QuereusError` with `StatusCode.ERROR`
when it returns `undefined`, distinguishing the two causes the way `getKeyNormalizerResolver`
does:

- unregistered → `no such collation sequence: X`
- registered, comparator only → `collation X cannot key a persisted structure: no key
  normalizer registered — pass { normalizer } to registerCollation`

`_getCollationNormalizer` is already a public-but-`@internal` method on `Database`; add it to
the `DatabaseInternal` facade (`database-internal.ts`) and reach it through the existing
`(this.db as DatabaseInternal)` cast the store uses elsewhere. A non-throwing probe is required
here — `getKeyNormalizerResolver()` throws, and the planner-side guards below must not.

**Blast radius to state in the handoff:** this fires on catalog rehydration too. Reopening a
persisted database from a connection that has not re-registered its custom collation now throws
at `CREATE TABLE`-from-catalog instead of silently mis-keying. That is the correct trade — the
alternative is reading rows under a key layout the connection cannot reproduce — but it is a
behavior change worth a line in `docs/plugins.md`.

### 5. The three "no byte encoder" guards become dead — remove them

Once §4 holds, these can no longer be true and should go, along with the doc paragraphs that
explain them:

| site | current test |
| --- | --- |
| `StoreTable.buildPKRangeBounds` (~903) | `getCollationEncoder(pkKeyCollations[0]) === undefined` → full scan |
| `StoreTable.analyzeIndexAccess` (~1001) | `getCollationEncoder(K) === undefined` → null |
| `StoreTable.indexSeekHonorsEnforcementCollation` (~1903) | `getCollationEncoder(K) === undefined` → false |
| `StoreModule.tryIndexAccessPlan` (~2059) | `getCollationEncoder(K) === undefined` → cost-only |

Verify the claim before deleting: each guards a collation that §4's constructor check has
already forced to have a normalizer (`pkKeyCollations[0]` and `K` both belong to the same
table). `StoreModule.tryIndexAccessPlan` reads `K` off `getTable(...)?.getConfig()`, i.e. a
constructed `StoreTable` — same guarantee. If a path is found where the table was never
constructed, keep that one guard and say so.

Note that the surrounding **coarseness** reasoning (`K === C || (K === 'NOCASE' && C === 'BINARY')`)
is unrelated and must stay: it compares the key collation against the *comparison* collation and
is still only sound for built-in names. A custom `K` simply fails the `K === C` test unless the
index column names the same custom collation.

### 6. Kill `resolveKeyNormalizer`

`packages/quereus/src/util/key-serializer.ts#resolveKeyNormalizer` is the built-ins-only helper
that silently returns identity on a miss. Its own doc comment says to delete it once the store is
converted. Its remaining callers are both in `store-module.ts` and are *value* dedup, not key
bytes — the same class of bug, one layer up:

- `buildIndexEntries` (~1001): the in-pass duplicate check for `CREATE UNIQUE INDEX`.
- `validateUniqueOverExistingRows` (~1119): `ALTER TABLE … ADD CONSTRAINT UNIQUE` / `SET COLLATE`.

Both must resolve through `db.getKeyNormalizerResolver()`. Both then reject a comparator-only
collation with the engine's error message, which is correct: you cannot dedup rows you cannot
bucket. Delete `resolveKeyNormalizer` and its export from `packages/quereus/src/index.ts`; export
`BUILTIN_NORMALIZERS` in its place (the store's default resolver needs it). Update the two engine
specs that import it (`collation-normalizer.spec.ts`, `test/util/json-canonical.spec.ts`) to index
`BUILTIN_NORMALIZERS` directly.

### 7. Tripwire, not a ticket

`encodeObject` runs the collation normalizer over the *canonical JSON string* of a JSON value, and
`decodeObject` `JSON.parse`s the result. Under the default `NOCASE` that already lowercases object
keys inside the key bytes; under a custom normalizer that reorders or deletes characters the
decoded string may not even be valid JSON. Nothing in the store's row path decodes an object key
today (`decodeCompositeKey` has no `src/` caller — rows are serialized separately), so this is
latent. Leave a `NOTE:` comment at `encodeObject` saying so, and mention it in the handoff. Do not
file a ticket.

## Expected behavior after the fix

- The reproduction raises `UNIQUE constraint failed` on the second insert; `t` holds one row.
- `db.registerCollation('NOCASE', cmp)` with no normalizer, then `create table … collate NOCASE
  primary key … using store`, raises at `CREATE TABLE` naming the collation.
- `using store(collation = 'NOSPACE')` on a table with an index, with `NOSPACE` unregistered,
  raises at `CREATE TABLE`.
- `BINARY` and `NOCASE` produce byte-identical keys to today. `RTRIM` does too, except for keys
  ending in non-`0x20` whitespace, where it now matches its own comparator (§2).
- `yarn test` and `yarn test:store` both pass. `test:store` matters here — it is the suite that
  exercises the store path for constraints and ALTER.

## TODO

### Phase 1 — engine seam
- Add `_getCollationNormalizer(name: string): KeyNormalizer | undefined` to the `DatabaseInternal`
  interface in `packages/quereus/src/core/database-internal.ts`.
- Export `BUILTIN_NORMALIZERS` from `packages/quereus/src/index.ts`.

### Phase 2 — store key encoding
- In `encoding.ts`: delete `CollationEncoder`, `collationEncoders`, `registerCollationEncoder`,
  `getCollationEncoder`, and the three built-in encoder constants. Add
  `BUILTIN_KEY_NORMALIZER_RESOLVER` (over the engine's `BUILTIN_NORMALIZERS`; throws
  `no such collation sequence: X` on an unknown name).
- Add `normalizers?: KeyNormalizerResolver` to `EncodeOptions`; use it in `encodeText` and
  `encodeObject`; remove both `?? NOCASE_ENCODER` fallbacks.
- Add the `NOTE:` tripwire comment at `encodeObject` (§7).
- Drop the removed symbols from `packages/quereus-store/src/common/index.ts`.
- Bind `normalizers: db.getKeyNormalizerResolver()` into `StoreTable.encodeOptions` (constructor and
  wherever `updateSchema` rebuilds it).
- Thread a `KeyNormalizerResolver` into `StoreModule.buildIndexEntries` from `createIndex` and
  `rebuildSecondaryIndexes` (whose two `alterTable` callers have `db`).

### Phase 3 — DDL validation and guard removal
- Add the constructor/`updateSchema` validation of §4 (PK key collations, plus `K` when the table has
  any secondary index).
- Delete the four `getCollationEncoder(...) === undefined` guards of §5 and their doc paragraphs,
  after confirming each is unreachable. Keep the coarseness comparisons.
- Rewrite the stale doc comment in `resolvePkKeyCollations` (store-table.ts ~115) that describes the
  `?? NOCASE_ENCODER` residual as out of scope.

### Phase 4 — kill the built-ins-only normalizer
- Convert `store-module.ts`'s two `resolveKeyNormalizer` call sites to `db.getKeyNormalizerResolver()`.
- Delete `resolveKeyNormalizer` from `key-serializer.ts` and from the package index.
- Update `packages/quereus/test/collation-normalizer.spec.ts` and `test/util/json-canonical.spec.ts`.

### Phase 5 — tests and docs
- Extend `packages/quereus-store/test/custom-collation.spec.ts` (or add
  `test/custom-collation-key.spec.ts`) with: the reproduction above collapsing to one row; a
  composite PK mixing a custom-NOCASE text column with an integer column; a secondary-index scan and
  an `update` that moves a PK across the collation's equivalence classes; the two DDL rejections
  (comparator-only, unregistered `K`); and a regression case asserting `BINARY`/`NOCASE` key bytes
  are unchanged.
- Rewrite `packages/quereus-store/test/encoding.spec.ts`'s "collation encoder" describe block against
  `normalizers` / `BUILTIN_KEY_NORMALIZER_RESOLVER`, including the new RTRIM-strips-only-`0x20`
  assertion.
- Delete `docs/sql.md` § COLLATE's "Store caveat — physical key bytes" paragraph (~line 2558).
- Update the store-collation residual notes in `docs/schema.md` and `docs/plugins.md`; add the
  rehydration blast-radius line from §4 to `docs/plugins.md`.
- Run `yarn build`, `yarn lint`, `yarn test`, then `yarn test:store`, streaming output with `tee`.
