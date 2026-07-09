---
description: When an application teaches the database its own text-sorting rule, GROUP BY, window partitions, and two of the join strategies still group rows with a built-in rule, so rows the application considers equal land in different groups and produce wrong answers.
files:
  - packages/quereus/src/core/database.ts                # add getKeyNormalizerResolver(); tighten _getCollationNormalizer
  - packages/quereus/src/core/database-internal.ts       # declare getKeyNormalizerResolver() on the internal facade (~256)
  - packages/quereus/src/types/logical-type.ts           # CollationResolver lives here; add KeyNormalizer/KeyNormalizerResolver
  - packages/quereus/src/runtime/emission-context.ts     # add resolveKeyNormalizer(), next to resolveCollation() (~205)
  - packages/quereus/src/runtime/emit/hash-aggregate.ts  # ~54 GROUP BY key normalizers
  - packages/quereus/src/runtime/emit/window.ts          # ~69 PARTITION BY key normalizers
  - packages/quereus/src/runtime/emit/bloom-join.ts      # ~51 join key normalizers
  - packages/quereus/src/runtime/emit/asof-scan.ts       # ~85 partition key normalizers
  - packages/quereus/src/util/key-serializer.ts          # resolveKeyNormalizer stays, but becomes explicitly builtins-only
  - packages/quereus/test/collation-normalizer.spec.ts   # one existing assertion changes (see below)
  - packages/quereus/test/mv-custom-collation-maintenance.spec.ts  # this fix unblocks its aggregate-residual arm
difficulty: medium
---

# Row-grouping key normalizers must resolve against the database's collation registry

## Confirmed reproduction

Ran against current `main` (temporary spec, since deleted):

```ts
const db = new Database();
db.registerCollation('NOCASE', (a, b) => a.length - b.length,
	{ normalizer: (s) => 'x'.repeat(s.length) });   // every same-length pair is equal
await db.exec("create table src (id integer primary key, k text collate nocase, v integer)");
await db.exec("insert into src values (1, 'aa', 10), (2, 'bb', 5)");
```

| query | observed | correct |
| --- | --- | --- |
| `select id from src where k = 'bb'` | `[1, 2]` | ✅ |
| `select distinct k from src` | `[{k:'aa'}]` | ✅ |
| `select k, sum(v) as s from src group by k` | `[{k:'aa',s:10},{k:'bb',s:5}]` | ❌ should be one group, `s = 15` |
| `select id, sum(v) over (partition by k) from src` | `[{id:1,s:10},{id:2,s:5}]` | ❌ both rows should see `s = 15` |

So comparison and grouping disagree on the same column in the same connection.

Two more facts the reproduction pinned down:

- The **streaming** aggregate (`runtime/emit/aggregate.ts` ~99) is already correct — it
  builds a comparator through `ctx.resolveCollation()`. Only the **hash** aggregate is
  wrong. The two aggregate emitters must agree, since which one runs is an optimizer
  decision invisible to the user.
- `Database._getCollationNormalizer()` already exists and already does the right lookup,
  and **has no production callers at all** — it is an unused seam waiting for exactly this
  fix. (Only tests reference it, plus a `NOTE:` comment in `quereus-isolation`.)

## What to build

### 1. `Database.getKeyNormalizerResolver()`

Mirror `getCollationResolver()` (`core/database.ts` ~1458) exactly: lazily bound once so
identity is stable, reads the live `collations` map, no `checkOpen()`.

```ts
/** A per-collation string normalizer: two strings are equal under the collation
 *  iff their normalized forms are identical strings. */
type KeyNormalizer = (s: string) => string;
type KeyNormalizerResolver = (collationName: string | undefined) => KeyNormalizer;
```

Resolution rules — note the deliberate absence of any silent fallback, matching the
"no silent BINARY" contract `getCollationResolver()` established:

- `undefined` or the exact name `BINARY` → the identity normalizer (fast path; `BINARY`
  cannot be overridden, enforced by `registerCollation`).
- A registered collation carrying a normalizer → that normalizer.
- A registered collation with **no** normalizer → throw `QuereusError`, naming the
  collation and telling the embedder to pass `{ normalizer }` to `registerCollation`.
  Something like: `collation X has no key normalizer; grouping and hash-join keys require
  one — pass { normalizer } to registerCollation`.
- An unregistered name → throw `QuereusError`, reusing the existing wording
  `no such collation sequence: X`.

Put `KeyNormalizer` / `KeyNormalizerResolver` next to `CollationResolver` in
`types/logical-type.ts`, and declare `getKeyNormalizerResolver()` on `DatabaseInternal`
(`core/database-internal.ts` ~256) alongside `getCollationResolver()`.

### 2. Drop the built-in fallback inside `_getCollationNormalizer`

Today it ends with `return BUILTIN_NORMALIZERS[upper]` when the registry entry has no
normalizer. That fallback is itself a small bug: if an embedder re-registers `NOCASE` with
a custom comparator and *no* normalizer, the fallback hands back the built-in lowercase
normalizer — which does not partition strings the way the new comparator does. Grouping
would then be confidently wrong rather than loudly broken.

The built-ins are seeded **with** their normalizers in `registerDefaultCollations()`
(`database.ts` ~387), so removing the fallback costs nothing for a fresh database. Reduce
the method to a plain `this.collations.get(normalizeCollationName(name))?.normalizer` and
let `getKeyNormalizerResolver()` own the throwing.

One existing test asserts the fallback and must be updated:
`test/collation-normalizer.spec.ts:95` — *"overriding a built-in collation without a
normalizer still falls back to the built-in normalizer"*. Flip it: the raw accessor now
returns `undefined`, and the resolver throws. Its comment about "persisted indexes keep
working" is unfounded — nothing on the index path calls this method.

### 3. `EmissionContext.resolveKeyNormalizer(collationName)`

Sits next to `resolveCollation()` (`runtime/emission-context.ts` ~205) and is the only
thing the four emitters call:

```ts
resolveKeyNormalizer(collationName: string | undefined): (s: string) => string {
	if (!collationName || collationName === 'BINARY') return IDENTITY;   // fast path
	this.getCollation(collationName);          // record the dependency for plan invalidation
	return this.db.getKeyNormalizerResolver()(collationName);
}
```

Recording the collation dependency matters: a plan that captured a normalizer must be
invalidated when the collation is re-registered, exactly as `resolveCollation()` does
today. Do not swallow `getCollation()`'s miss — let the resolver raise.

### 4. Convert the four call sites

Each becomes `ctx.resolveKeyNormalizer(<same name expression>)`:

- `hash-aggregate.ts` ~54 — `expr.getType().collationName`
- `window.ts` ~69 — `exprPlan.getType().collationName`
- `bloom-join.ts` ~51 — `effectiveCollationOfTypes(...)` (returns a non-optional `string`)
- `asof-scan.ts` ~85 — same `effectiveCollationOfTypes(...)` name already fed to
  `ctx.resolveCollation()` on the line above, so comparator and normalizer stay in lockstep

Drop the now-unused `resolveKeyNormalizer` import from all four.

### 5. Leave `util/key-serializer.ts`'s `resolveKeyNormalizer` in place — but say what it is

`quereus-store` and `quereus-isolation` still import it from the package index
(`src/index.ts` ~207) and neither has a `Database` handle threaded to the call site.
Both are covered by their own tickets (`bug-store-key-encoder-ignores-database-collations`
and the `NOTE:` at `quereus-isolation/src/isolated-table.ts:470`). Deleting or
hardening the function now would break them for no gain.

So: keep the function and its behavior, and re-document it as the *built-ins-only*
normalizer lookup — the exact analog of `builtinCollationResolver` in
`util/comparison.ts`. Add a `NOTE:` on it saying any caller holding a `Database` must use
`getKeyNormalizerResolver()` instead, and that the function can be deleted once the two
remaining callers are converted. `BUILTIN_NORMALIZERS` stays as-is.

## Tests

New spec (`test/collation-key-normalizer.spec.ts`, or fold into
`test/collation-normalizer.spec.ts`), all using the same length-only `NOCASE` override the
existing collation specs use (`mv-custom-collation-maintenance.spec.ts` ~28 already defines
`lengthOnly` / `lengthNormalizer` — copy the idiom, it is the only way to reach a custom
comparator today because DDL still rejects unknown collation names):

- `group by` over a `collate nocase` column returns **one** group summing to 15, agreeing
  with `where` and `distinct` on the same column.
- `sum(v) over (partition by k)` gives both rows 15.
- Streaming and hash aggregate give the same answer (force the hash path if the optimizer
  picks streaming for the tiny table — check how `test/optimizer/` specs pin a plan).
- A bloom join on a `collate nocase` text column matches rows the comparator considers
  equal. `test/logic/82-bloom-join.sqllogic` shows how to assert the plan really is a bloom
  join (`query_plan(...) where properties like '%bloom%'`); a `.sqllogic` file cannot
  register a collation, so this one has to be a `.spec.ts`.
- An AS OF scan partitioned on such a column. `test/logic/84-asof-scan.sqllogic` and
  `test/optimizer/asof-scan.spec.ts` show how to make the rule fire (left input monotonic
  on the match attribute, so wrap it in `order by ts`).
- A comparator-only collation (`registerCollation('CMPONLY', cmp)` with no normalizer)
  used as a `group by` key raises, and the message names `CMPONLY`.
- `BINARY` / `NOCASE` / `RTRIM` on a fresh database group exactly as before — the existing
  logic tests cover this, but assert one case directly too.

`test/mv-custom-collation-maintenance.spec.ts` documents (in its header) that this bug
blocked end-to-end coverage of the materialized-view aggregate-residual maintenance arm:
no SQL body could reach the discriminating case of two collation-equal, byte-different
group keys, because the grouping split them first. With this fix, that case is reachable —
add the end-to-end assertion there and delete the note that says it is impossible.

## TODO

- [ ] Add `KeyNormalizer` / `KeyNormalizerResolver` to `types/logical-type.ts`.
- [ ] Add `Database.getKeyNormalizerResolver()`; declare it on `DatabaseInternal`.
- [ ] Strip the `BUILTIN_NORMALIZERS` fallback from `Database._getCollationNormalizer()`.
- [ ] Add `EmissionContext.resolveKeyNormalizer()`, recording the collation dependency.
- [ ] Convert `hash-aggregate.ts`, `window.ts`, `bloom-join.ts`, `asof-scan.ts`.
- [ ] Re-document `util/key-serializer.ts#resolveKeyNormalizer` as builtins-only, with a
      `NOTE:` pointing at the two remaining external callers.
- [ ] Update `test/collation-normalizer.spec.ts:95` (fallback → `undefined` + resolver throws).
- [ ] New spec covering group by / partition by / bloom join / asof scan under a custom
      collation, plus the comparator-only "must raise" case.
- [ ] Reach the previously-unreachable aggregate-residual case in
      `test/mv-custom-collation-maintenance.spec.ts`.
- [ ] Update `docs/` where collation registration is described (search for
      `registerCollation` / `getCollationResolver`) so the normalizer requirement for
      grouping is stated, not only for indexes.
- [ ] `yarn test` and `yarn lint` from the repo root.
