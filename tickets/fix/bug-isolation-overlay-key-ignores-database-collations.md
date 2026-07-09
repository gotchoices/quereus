----
description: When an application teaches the database its own text-sorting rule and then changes a row's primary key to a value the rule considers identical to the old one, a scan inside that transaction can return the row twice — once with the old value and once with the new.
files:
  - packages/quereus-isolation/src/isolated-table.ts       # ~470: pkNormalizers built from the builtins-only resolveKeyNormalizer
  - packages/quereus/src/util/key-serializer.ts            # resolveKeyNormalizer — the builtins-only lookup being called
  - packages/quereus/src/core/database.ts                  # getKeyNormalizerResolver() — the database-aware resolver to use instead
  - packages/quereus-isolation/test/                       # sibling suites; no coverage of a custom-collation PK rewrite today
difficulty: medium
----

# Isolation overlay's modified-PK set ignores the database's collation registry

## Plain statement of the problem

An application can teach a Quereus connection its own rule for comparing text — for
example one that ignores case, or that treats `'a b'` and `'ab'` as the same value. It
does this with `db.registerCollation`, supplying both a comparison function and a
`normalizer` (a function that maps every value the rule considers equal onto one
identical string).

The transaction isolation layer keeps uncommitted writes in an *overlay* table and
merges them over the underlying table when you scan. To know which underlying rows the
overlay replaces, it builds a set of the primary keys that the overlay has modified, and
skips any underlying row whose key is in that set.

It builds that set with a lookup that only knows the three **built-in** rules
(`BINARY`, `NOCASE`, `RTRIM`) with their **original** meanings. A primary key column
declared under an application-registered collation — or under a built-in the application
has replaced — is keyed by raw bytes instead.

So if a row's primary key is rewritten to a value the application's rule considers
*equal* to the old one but whose bytes differ, the overlay's key and the underlying
row's key do not match. The underlying row is not shadowed, and a scan inside the
transaction returns **both** the old row and the new one.

## Concrete shape

```
db.registerCollation('NOCASE', myComparator, { normalizer: myNormalizer });
create table t (k text collate nocase primary key, v integer);
insert into t values ('abc', 1);          -- committed

begin;
  update t set k = 'ABC';                  -- collation-equal, byte-different
  select * from t;                         -- expected 1 row; a secondary-index scan
                                           -- can return 2 ('abc' and 'ABC')
```

The divergence bites the secondary-index merge path in `isolated-table.ts`, where
`pkNormalizers` are built from `resolveKeyNormalizer` (the built-ins-only lookup) rather
than from the connection's registry. Note this is **not** limited to comparator-only
collations: a custom collation that *does* supply a normalizer is still ignored here,
because the lookup never consults the database at all.

## Why it is filed now

`bug-key-normalizer-ignores-database-collations` converted the engine's own hash-keyed
operators (`GROUP BY`, window `PARTITION BY`, bloom join, `AS OF` partitioning) onto
`Database.getKeyNormalizerResolver()`, which reads the live collation registry and raises
a clear error rather than guessing. Two callers of the old built-ins-only lookup were left
behind because neither has a `Database` threaded to the call site:

- the persistent store's key encoder — tracked by `bug-store-key-encoder-ignores-database-collations`;
- **this one**, which had no ticket. The review of the engine change found the handoff
  claimed both were covered; only the store was.

The divergence is acknowledged in a `NOTE:` at the call site and predates the engine
change — it is not a regression from it.

## Expected behavior

A primary-key rewrite to a collation-equal value must shadow the underlying row exactly,
so a scan inside the transaction returns one row. The overlay's modified-PK set must key
each PK column under that column's collation **as the connection defines it**.

## Scope

- Pin the duplicate-row behavior with a failing test first (a custom `NOCASE` override with
  a normalizer, a text PK, a case-only `update` inside a transaction, a secondary-index scan).
- Thread the connection's normalizer resolver — `Database.getKeyNormalizerResolver()`, or
  the pre-resolved normalizers — to the `IsolatedTable` call site, and use it in place of
  `resolveKeyNormalizer`.
- Decide what a **comparator-only** collation on a PK column should do here. The engine's
  hash sites raise `collation <name> has no key normalizer`; this site currently degrades
  silently. Raising is likely right, but it is a behavior change on a path that today
  merely under-shadows — call it out rather than slipping it in.
- Once this and the store ticket land, `resolveKeyNormalizer` in
  `packages/quereus/src/util/key-serializer.ts` has no callers left and its export from
  `@quereus/quereus` can be deleted (its doc comment already says so).
