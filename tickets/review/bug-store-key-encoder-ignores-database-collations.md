---
description: The persistent store used to lay out its keys with a built-in text-sorting rule even when the application had taught the database its own rule, so two values the application considers identical could be stored as two separate primary-key rows; the store now uses the application's rule and refuses, at table-creation time, any rule it cannot use for keys.
files:
  - packages/quereus/src/core/database-internal.ts        # + _getCollationNormalizer on the facade
  - packages/quereus/src/index.ts                         # resolveKeyNormalizer export → BUILTIN_NORMALIZERS
  - packages/quereus/src/util/key-serializer.ts           # resolveKeyNormalizer deleted
  - packages/quereus/test/collation-normalizer.spec.ts    # rewritten against BUILTIN_NORMALIZERS
  - packages/quereus/test/util/json-canonical.spec.ts     # rewritten against BUILTIN_NORMALIZERS
  - packages/quereus-store/src/common/encoding.ts         # encoder registry deleted; EncodeOptions.normalizers
  - packages/quereus-store/src/common/index.ts            # exports BUILTIN_KEY_NORMALIZER_RESOLVER
  - packages/quereus-store/src/common/store-table.ts      # validateKeyCollations(); 3 guards removed; 2 seek sites fixed
  - packages/quereus-store/src/common/store-module.ts     # buildIndexEntries/rebuildSecondaryIndexes/validateUniqueOverExistingRows take a resolver; 1 guard removed
  - packages/quereus-store/test/custom-collation-key.spec.ts  # NEW — 8 cases
  - packages/quereus-store/test/encoding.spec.ts          # "collation encoder" block rewritten
  - packages/quereus-store/test/pushdown.spec.ts          # guard test replaced
  - docs/sql.md, docs/schema.md, docs/store.md, docs/plugins.md, docs/optimizer.md
difficulty: medium
---

# Store key encoding now resolves collations against the database

## What was wrong

`quereus-store`'s `encoding.ts` held a **process-global** map from collation name to a
byte encoder, seeded with only `BINARY` (identity), `NOCASE` (`toLowerCase`), and `RTRIM`,
and it silently fell back to the `NOCASE` encoder on an unknown name. The database's own
per-connection registry (`Database.registerCollation`) was never consulted. Every value
comparison `StoreTable` makes already went through `db.getCollationResolver()`, so the key
layout and the comparator could disagree about which rows are the same row.

Reproduction that used to succeed and now raises `UNIQUE constraint failed`:

```ts
const db = new Database();
db.registerCollation('NOCASE', noSpace, (s) => s.replace(/ /g, ''));  // 'a b' == 'ab'
db.registerModule('store', new StoreModule(provider));
await db.exec(`create table t (k text collate NOCASE primary key, v text) using store`);
await db.exec(`insert into t values ('a b', 'one')`);
await db.exec(`insert into t values ('ab',  'two')`);   // was accepted; table held a dup PK
```

## What changed

**The encoder registry is gone.** `CollationEncoder`, `registerCollationEncoder`,
`getCollationEncoder`, the three built-in encoder constants, and their re-exports from
`packages/quereus-store/src/common/index.ts` were deleted (a public API break, waived by
AGENTS.md). In their place `EncodeOptions` grows `normalizers?: KeyNormalizerResolver`.
`encodeText`/`encodeObject` resolve through it with **no fallback**. Its default,
`BUILTIN_KEY_NORMALIZER_RESOLVER`, is built over the engine's exported `BUILTIN_NORMALIZERS`
(not a store-local copy) and throws `no such collation sequence: X` on anything else.

**`StoreTable` binds the resolver once**, beside `collationResolver`:

```ts
this.encodeOptions = {
  collation: config.collation || 'NOCASE',
  normalizers: db.getKeyNormalizerResolver(),
};
```

so every `buildDataKey` / `buildIndexKey` / `encodePkPrefixBounds` call inherits it.
`StoreModule.buildIndexEntries`, `rebuildSecondaryIndexes`, and
`validateUniqueOverExistingRows` each take a `KeyNormalizerResolver` threaded down from a
caller that holds `db`.

**DDL-time validation** (`StoreTable.validateKeyCollations`, run from the constructor and
from `updateSchema`) rejects a collation the table's key encoding would need but cannot use:

- unregistered → `no such collation sequence: X`
- registered comparator-only → `collation X cannot key a persisted structure: no key
  normalizer registered — pass { normalizer } to registerCollation`

It checks exactly the collations that are actually encoded: every defined `pkKeyCollations`
entry, plus the table key collation `K` when the table has a secondary index **or** a PK
member that `resolvePkKeyCollations` left `undefined` yet whose declared type can still hold
a string (`ANY` / `JSON` — those fall back to `K` inside `encodeValue`). An integer-PK table
with no index is never made unopenable by a `K` it does not encode with.

**Four now-unreachable guards were deleted** (`getCollationEncoder(...) === undefined` in
`buildPKRangeBounds`, `analyzeIndexAccess`, `indexSeekHonorsEnforcementCollation`, and
`StoreModule.tryIndexAccessPlan`). The K-vs-C *coarseness* reasoning next to them is
unrelated and stays. `tryIndexAccessPlan` reads `K` off a constructed `StoreTable` (or
defaults to `NOCASE` when the table is absent), so it carries the same guarantee.

**`resolveKeyNormalizer` is deleted** from `packages/quereus/src/util/key-serializer.ts`
and from the package index; `BUILTIN_NORMALIZERS` is exported in its place. Its two
remaining callers (the `CREATE UNIQUE INDEX` in-pass dedup and the
`ADD CONSTRAINT UNIQUE` / `SET COLLATE` existing-row scan) now resolve through
`db.getKeyNormalizerResolver()`.

## Deliberate behavior changes — read these

1. **`RTRIM` key bytes change for non-space whitespace, on purpose.** The retired store
   encoder stripped `/\s+$/` (tab, NBSP, every Unicode space); the engine's
   `RTRIM_NORMALIZER` — and `RTRIM_COLLATION`, the comparator the store's own UNIQUE
   enforcement uses — strip only ASCII `0x20`. So `'a\t'` and `'a'` used to encode to the
   *same* key while the comparator called them different values: a distinct-under-RTRIM row
   could be silently clobbered by its neighbour. Adopting the engine normalizer fixes that.
   **Any persisted RTRIM-keyed row whose key ends in non-space whitespace changes key
   bytes.** This is the one place the original "the built-ins keep encoding byte-identically"
   constraint is knowingly not honored, because honoring it would preserve a bug. Backwards
   compatibility is waived project-wide. `BINARY` and `NOCASE` are byte-identical.

2. **Rehydration now raises instead of mis-keying.** `validateKeyCollations` fires on
   catalog rehydration too. Reopening a persisted database from a connection that has not
   re-registered its custom collation throws at `CREATE TABLE`-from-catalog rather than
   reading rows under a key layout the connection cannot reproduce. Documented in
   `docs/plugins.md` ("Register store collations before opening the database").

## Two fixes beyond the ticket's TODO list

- **`analyzeIndexAccess` and `buildIndexRangeBounds` were building `{ collation: coll }`
  literals**, dropping the resolver and silently reverting those two seek paths to the
  built-ins-only default. Both now pass `this.encodeOptions`. Without this, a custom `K`
  would have thrown mid-seek (or, worse, encoded a window under the wrong normalizer).
  `buildIndexRangeBounds` lost its now-redundant `coll` parameter — it is `protected`, so an
  out-of-tree subclass overriding it would need updating.

- **The two value-dedup sites gate on `logicalTypeCanHoldText`** before asking the resolver
  for a normalizer, mirroring what `quereus-isolation`'s `pkNormalizers` already does. Without
  the gate, `n integer collate mycoll` under a comparator-only collation would raise in the
  store where the engine's own hash sites accept it (`serializeRowKey` normalizes only string
  values, so the collation cannot affect how such a key buckets).

## Tripwires parked in code

- `encodeObject` (`encoding.ts`): the normalizer runs over the *canonical JSON string*, and
  `decodeObject` `JSON.parse`s the result. Under a custom normalizer that reorders or deletes
  characters the decoded string may not be valid JSON. Latent — nothing in the row path
  decodes an object key today (`decodeCompositeKey` has no `src/` caller). `NOTE:` comment at
  the function.
- `buildPKRangeBounds` (`store-table.ts`): a range window over a text key is sound only when
  the key normalizer is **order-preserving** with respect to its comparator.
  `registerCollation` guarantees only that a normalizer *partitions* strings the way the
  comparator calls them equal, not that it preserves order. All three built-ins are
  order-preserving, and today only a built-in name can reach a PK column (DDL rejects any
  other), so this is not reachable. It becomes reachable the day
  `backlog/feat-ddl-accepts-registered-collations` lands. `NOTE:` comment at the function,
  plus a paragraph in `docs/store.md` § Collation Support.

## Use cases to exercise when reviewing

- `packages/quereus-store/test/custom-collation-key.spec.ts` (new, 8 cases): the
  reproduction collapsing to one row; a composite PK mixing custom-NOCASE text with an
  integer; a point PK seek that lands on the equivalence class; an `update` that moves a PK
  both *within* and *across* the collation's equivalence classes; secondary-index scan +
  delete with the PK suffix under the override; the two DDL rejections (comparator-only PK
  collation, unregistered `K`); an integer-PK-no-index table staying openable under an
  unusable `K`; and a `BINARY`/`NOCASE`/`RTRIM` key-byte regression assertion.
- `packages/quereus-store/test/encoding.spec.ts` § "key normalizer resolution": the
  RTRIM-strips-only-`0x20` assertions, the no-silent-fallback throw, and resolver
  passthrough via `encodeCompositeKey`'s per-column collation override.
- `packages/quereus-store/test/pushdown.spec.ts`: the old white-box "comparator-only
  collation falls back to full scan" test is replaced by a positive control plus an
  assertion that the unresolvable collation is rejected at `CREATE TABLE` instead.

## Validation performed

`yarn build`, `yarn lint`, `yarn test` (6697 + 789 + siblings, all passing), and
`yarn test:store` (6692 passing, 14 pending) all green. No pre-existing failures surfaced.

## Known gaps — the reviewer should treat these as a floor, not a finish line

- **No test drives `rebuildSecondaryIndexes` or `validateUniqueOverExistingRows` under a
  custom collation.** Both were threaded a resolver, and both are only reachable through
  `ALTER TABLE … SET COLLATE` / `ADD CONSTRAINT UNIQUE` / `ALTER PRIMARY KEY`. Their existing
  tests all run under the built-ins, where the new resolver and the old helper agree, so those
  tests would not catch a mis-threaded resolver. This is the least-covered part of the change.
- **No reopen/rehydration test** for the new `CREATE TABLE`-from-catalog rejection. The
  behavior is reasoned about, not demonstrated; a LevelDB-backed reopen without re-registering
  the collation is the missing case.
- **No test for an `ANY`- or `JSON`-typed PK column** falling back to `K` — the branch in
  `validateKeyCollations` that adds `K` for a `columnCanHoldText` PK member with no
  `pkKeyCollations` entry. It was reasoned from `resolvePkKeyCollations`' `isTextual` test.
- **`StoreTable.validateKeyCollations` re-runs on every `updateSchema`.** Cheap (a Set over
  at most a few names plus a Map lookup each), and `updateSchema` is a DDL-frequency call, so
  it is not a hot path. Not parked as a `NOTE:` because it is not conditional on anything.
- `docs/store.md` § Collation Support had a stale "Future Work" block proposing per-column
  PK/index collations that already exist; it was replaced along with the encoder prose. Worth
  a skim that nothing else in that file contradicts the new model.
