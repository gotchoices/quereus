----
description: When an application teaches the database its own text-sorting rule, GROUP BY, window partitions, and two of the join strategies still group rows using a built-in rule, so rows the application considers equal land in different groups and produce wrong answers.
files:
  - packages/quereus/src/util/key-serializer.ts        # resolveKeyNormalizer ~27 — hard-coded three-name switch
  - packages/quereus/src/runtime/emit/hash-aggregate.ts # ~56 — GROUP BY key normalizers
  - packages/quereus/src/runtime/emit/window.ts         # ~70 — PARTITION BY key normalizers
  - packages/quereus/src/runtime/emit/bloom-join.ts     # ~51 — join key normalizers
  - packages/quereus/src/runtime/emit/asof-scan.ts      # ~85 — partition key normalizers
  - packages/quereus/src/runtime/emission-context.ts    # resolveCollation() — the per-database seam the normalizer path is missing
  - packages/quereus/src/core/database.ts               # registerCollation(name, comparator, { normalizer }) — the normalizer is already stored here
difficulty: medium
----

# Row-grouping key normalizers ignore the database's collation registry

## Plain statement of the problem

An application can teach a Quereus connection its own text-sorting rule (a *collation*),
including replacing what the built-in `NOCASE` means. Everything that *compares* two
values honors that: `where`, `order by`, `distinct`, `unique`, index seeks.

Everything that *groups* rows does not. `GROUP BY`, `PARTITION BY`, the hash-join Bloom
filter, and the AS OF scan all turn each key value into a short string first, then group
rows whose strings match exactly. The function that produces that string
(`resolveKeyNormalizer`) is a fixed three-way switch over `BINARY` / `NOCASE` / `RTRIM`
with their *original* meanings; any other name — and any redefinition of those names —
falls through to "use the string as-is", i.e. byte grouping.

So comparison and grouping disagree, and `GROUP BY` silently returns the wrong number of
groups.

## Reproduction (verified, current `main`)

```ts
const db = new Database();
// Redefine NOCASE on this connection: every pair of same-length strings is equal.
db.registerCollation('NOCASE', (a, b) => a.length - b.length,
	{ normalizer: (s) => 'x'.repeat(s.length) });

await db.exec("create table src (id integer primary key, k text collate nocase, v integer)");
await db.exec("insert into src values (1, 'aa', 10), (2, 'bb', 5)");

await db.eval("select id from src where k = 'bb'");        // [1, 2]  — comparison is correct
await db.eval("select distinct k from src");               // one row — correct
await db.eval("select k, sum(v) as s from src group by k");
```

Observed for the `group by`: **two** groups, `[{k:'aa',s:10},{k:'bb',s:5}]`. Under this
connection's `NOCASE`, `'aa'` and `'bb'` are the same value, so there is exactly one group
with `s = 15` — which is what the `where` and the `distinct` on the same column already
agree on.

Note the connection *did* supply a normalizer. It is stored on the `Database` (see
`registerCollation`'s `{ normalizer }` option) and simply never consulted by these four
emitters.

## Why this is a distinct bug from its siblings

Three tickets in this family moved *comparison* onto the per-database resolver
(`3.2-collation-resolver-seam`, `3.3-memory-vtab-collation-resolver`,
`3.4-store-isolation-collation-resolver`), and `3.5-core-callers-collation-resolver` did
the same for materialized-view maintenance and the planner's contradiction checker. None
of them touched *key normalization*, which is a separate registry with a different value
type: a `(s: string) => string` normalizer, not a comparator.

`fix/bug-store-key-encoder-ignores-database-collations` is the exact same defect on the
persistent-store side (`quereus-store/src/common/encoding.ts`). The two probably want a
single shared seam.

## Expected behavior

- `group by` / `partition by` over a column collated with a connection-registered
  collation groups rows exactly as `distinct` and `=` do on that column.
- The Bloom-filter and AS OF partition paths agree with the join's own comparator, so no
  matching row is filtered out.
- A collation registered **without** a normalizer cannot key a grouping structure. Today it
  silently gets identity (byte) grouping. It should raise — the same "no silent BINARY"
  contract `getCollationResolver()` established — naming the collation and telling the
  embedder to supply a normalizer.
- An unregistered collation name likewise raises rather than grouping by bytes.
- `BINARY` / `NOCASE` / `RTRIM` at their default registrations normalize exactly as today.

## Notes for whoever plans this

- The natural seam is a `Database.getKeyNormalizer(name)` (mirroring
  `getCollationResolver()`), reached from emitters through `EmissionContext` — which
  already exposes a per-database `resolveCollation()` and is the object every one of the
  four call sites holds.
- `resolveKeyNormalizer` is re-exported from the package index (`src/index.ts` ~207).
  Whether it survives as a built-ins-only helper (like `builtinCollationResolver`) or is
  deleted is a decision for the plan.
- `test/mv-custom-collation-maintenance.spec.ts` documents where this bug blocked
  end-to-end coverage of the materialized-view aggregate-residual maintenance arm: that
  arm's key comparisons are collation-correct, but no SQL body can currently reach the
  discriminating case (two collation-equal, byte-different group keys) because the
  grouping itself splits them first. Landing this fix unblocks that test.
