----
description: An application can teach the database a custom text-sorting rule, but it cannot then use that rule when declaring a table column — only the three built-in rules are accepted there, so the custom rule is unusable for a column's own ordering.
prereq:
files:
  - packages/quereus/src/schema/table.ts        # validateCollationForType ~194 — the gate
  - packages/quereus/src/types/builtin-types.ts # TEXT_TYPE.supportedCollations ~113
  - packages/quereus/src/types/logical-type.ts  # LogicalType.supportedCollations ~54
  - packages/quereus/src/core/database.ts       # registerCollation, getCollationResolver
difficulty: medium
----

# Column DDL rejects collations the connection has registered

## What happens today

An embedder can register a custom text-sorting rule (a *collation*) on a database
connection:

```js
db.registerCollation('REVERSE', (a, b) => (a < b ? 1 : a > b ? -1 : 0));
```

It then works in queries (`order by k collate REVERSE`) and in index DDL
(`create index ix on t (v collate REVERSE)`), but **not** in column DDL:

```sql
create table t (k text collate REVERSE primary key);
-- Unknown collation 'REVERSE' for type 'TEXT' on column 'k'
--   (expected one of: BINARY, NOCASE, RTRIM)
```

The check lives in `validateCollationForType` (`schema/table.ts`), which compares
the requested name against a **static list** hard-coded on each logical type
(`TEXT_TYPE.supportedCollations = ['BINARY','NOCASE','RTRIM']`). It never consults
the connection's registry, so no custom collation can ever pass.

The list is not a safety net either. A logical type with *no* list — `INTEGER`,
`REAL`, `BLOB` — accepts any collation name whatsoever, including nonsense
(`create table t (k integer collate frobnicate primary key)` parses fine; it now
fails later, when the memory table tries to build a comparator).

So the gate is simultaneously too strict (rejects a collation the connection
actually has) and too loose (waves through a collation nobody has, on the types
where it happens to be a no-op).

## Why it matters

Registering a collation is the documented way to teach Quereus a domain sort
order — a phone-number collation, a locale-aware one, a codepoint one. Not being
able to declare it on the column means you cannot get a table's primary key or a
`UNIQUE` constraint to enforce it; you can only apply it per-query, per-index.

This surfaced while implementing `3.3-memory-vtab-collation-resolver`, whose
intended headline test (`create table t (k text collate REVERSE primary key)`)
could not be written. The test suite works around it by overriding the built-in
`NOCASE` on one connection and by putting the custom collation on an index column
instead.

## Expected behavior

- A collation registered on the connection is accepted in column DDL for any type
  that supports collations at all (i.e. TEXT, and any custom type that declares a
  non-empty supported list).
- A collation nobody has registered is rejected, for **every** type — including
  `INTEGER`/`REAL`/`BLOB`, which today accept anything.
- A type that explicitly declares it supports no collations (JSON, temporal) keeps
  rejecting every non-BINARY name.
- Error wording stays recognizable: `test/logic/102.1-unique-edge-cases.sqllogic`
  and `test/logic/41.7-alter-column-collate.sqllogic` pin `Unknown collation`.

## Open questions for whoever plans this

- `validateCollationForType` has no `Database` in scope today. Threading one in
  touches `columnDefToSchema` and the schema differ's `extractDeclaredCollation`,
  which the create/apply-parity comment in `schema/table.ts` says must not drift.
- A schema persisted with a custom collation cannot be reopened unless the embedder
  re-registers it first. `3.2-collation-resolver-seam` already made that a loud
  error rather than a silent byte-order fallback; declaring custom collations on
  columns widens the surface where that bites.
