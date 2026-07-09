----
description: When an application supplies its own text-sorting rule, the persistent store still lays out its keys using a built-in rule, so two values the application considers identical can both be stored as separate primary-key rows.
files:
  - packages/quereus-store/src/common/encoding.ts        # collationEncoders registry; encodeText/encodeObject; `getCollationEncoder(collation) ?? NOCASE_ENCODER`
  - packages/quereus-store/src/common/store-table.ts     # resolvePkKeyCollations(); pkKeyCollations
  - packages/quereus-store/src/common/key-builder.ts     # buildDataKey / buildIndexKey consume the per-column key collations
  - packages/quereus/src/core/database.ts                # registerCollation(name, comparator, { normalizer }) — the normalizer is exactly the missing input
  - packages/quereus-store/test/custom-collation.spec.ts # sibling suite; the comparison side is covered there
difficulty: medium
----

# Store key encoding ignores the database's collation registry

## Plain statement of the problem

A Quereus application can register its own text-sorting rule on a connection — for
example one that ignores spaces, so `'a b'` and `'ab'` are the same value. It can also
*replace* the meaning of the built-in `NOCASE` rule.

The persistent key-value store turns each text key into a byte string before writing it,
using a small **encoder** table that only ever contains three entries: `BINARY`,
`NOCASE`, and `RTRIM` — with their *original* meanings. Any name it does not recognize
silently falls back to the `NOCASE` encoder (lowercasing). The database's own registry is
never consulted.

The result is that comparison and storage disagree. The comparator says two values are the
same row; the key encoder puts them in two different rows.

## Reproduction (verified, current `main`)

```ts
const db = new Database();
// Redefine NOCASE on this connection to mean "ignore spaces".
db.registerCollation('NOCASE', noSpace, (s) => s.replace(/ /g, ''));
db.registerModule('store', new StoreModule(provider));

await db.exec(`create table t (k text collate NOCASE primary key, v text) using store`);
await db.exec(`insert into t values ('a b', 'one')`);
await db.exec(`insert into t values ('ab',  'two')`);   // expected: PK conflict
```

Observed: no error. `select k, v from t` returns **both** rows —
`[{k:'a b',v:'one'}, {k:'ab',v:'two'}]`. Under this connection's `NOCASE` those are one
key, so the table now holds a duplicate primary key.

The same divergence applies to `RTRIM`, and to any custom collation named on a secondary
index column (the index key bytes are encoded by the same path).

## Why the comparison side is already correct

`3.4-store-isolation-collation-resolver` routed every *value comparison* in
`StoreTable` / `IsolatedTable` through `db.getCollationResolver()`, so `UNIQUE`
enforcement over non-key columns, pushed-constraint re-checks, and the isolation
overlay's merge comparator all honor the connection's registry. Key *encoding* was
explicitly out of that ticket's scope; it lives in `encoding.ts`, a distinct registry
(`registerCollationEncoder` / `getCollationEncoder`) whose values are
`(s: string) => string` normalizers rather than comparators.

## What a fix needs to decide

`Database.registerCollation(name, comparator, { normalizer })` already accepts exactly the
function the encoder needs: a normalizer whose output equality partitions strings into the
same equivalence classes as the comparator. It is currently required only for a collation
to back a compound *memory* index. The store never reads it.

Open questions the fix should answer, not assume:

- **Where does the store get the normalizer from?** The natural seam is a
  `getKeyNormalizer(name)` on `Database` (there is already an internal
  `resolveKeyNormalizer`), consulted by `encodeText` in place of the module-level
  `collationEncoders` map. That makes key encoding per-database rather than per-process,
  which is the same shift `getCollationResolver()` made for comparison.
- **What happens to a comparator-only collation** (registered with no normalizer)? It
  cannot key a store table. Today it silently gets the `NOCASE` encoder. It should
  probably raise at `CREATE TABLE` / `CREATE INDEX` time — "collation X cannot key a
  persisted structure: no normalizer registered" — rather than at first write.
- **What happens to an unregistered name?** Currently the `?? NOCASE_ENCODER` fallback.
  It should raise, matching `getCollationResolver`'s no-silent-BINARY contract.
- **Existing stores.** Backwards compatibility is waived project-wide (AGENTS.md), but the
  built-ins must keep encoding byte-identically or every persisted key moves. Only the
  *fallback* branch and the custom-name branch should change behavior.

## Expected behavior after the fix

- Inserting `'ab'` after `'a b'` into the reproduction's table raises a primary-key
  `UNIQUE constraint failed`, and the table holds one row.
- A store table or index naming a collation the connection has not registered raises
  rather than encoding under `NOCASE`.
- `BINARY` / `NOCASE` / `RTRIM` with their default registrations produce byte-identical
  keys to today.

## Related

- `backlog/feat-ddl-accepts-registered-collations` — a *column*'s `COLLATE` is currently
  restricted to a static per-type list, so a custom collation reaches a store PK only by
  overriding a built-in. Landing that feature widens the blast radius of this bug.
- `docs/sql.md` § COLLATE now carries a "Store caveat — physical key bytes" paragraph
  describing the divergence; delete it when this lands.
