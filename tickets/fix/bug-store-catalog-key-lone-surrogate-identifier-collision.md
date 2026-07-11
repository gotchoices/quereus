---
description: Names and stored schema text containing a broken half-character are silently mangled when a persistent database is saved, so two differently-named tables can collide into one and a saved default value can come back changed.
files:
  - packages/quereus-store/src/common/key-builder.ts   # buildCatalogKey / buildViewCatalogKey / buildMaterializedViewCatalogKey / buildStatsKey
  - packages/quereus-store/src/common/store-module.ts  # saveTableDDL (DDL text mangled) / rehydrateCatalog — the reader that loses the entry
  - packages/quereus-sync/src/metadata/keys.ts         # buildColumnVersionKey etc. — same identifier-in-key shape
  - packages/quereus-store/src/common/encoding.ts      # assertEncodableText — the guard values already get
difficulty: easy
---

# Catalog keys are not injective over unpaired surrogates in identifiers

## What is wrong

A JavaScript string is a sequence of 16-bit code units. A character above `U+FFFF` occupies
two of them — a *surrogate pair*. A string can also hold a **lone** (unpaired) surrogate: a
half of a pair with no matching other half. That is a legal JavaScript string, and a legal
SQL identifier when quoted, but it is not valid Unicode — no UTF-8 byte sequence encodes it.

`TextEncoder` silently replaces every unpaired surrogate with the replacement character
`U+FFFD` (bytes `EF BF BD`). All 2048 distinct lone surrogates therefore encode to the same
three bytes.

The store's catalog keys — the byte keys under which each table's `CREATE TABLE` text is
persisted — are built by running the qualified `schema.table` name straight through
`TextEncoder` (`buildCatalogKey`). So two tables whose names differ only in a lone
surrogate get the same catalog key, and the second `CREATE TABLE` overwrites the first's
DDL. On reopen, only one of them rehydrates: the other table's schema is gone, while its
data store (keyed by a JavaScript string, not by bytes) is still sitting on disk,
orphaned.

The same encoding is used for view and materialized-view catalog keys and for stats keys,
so those collide too.

## Why this is filed separately

`bug-store-lone-surrogate-key-collision` fixed the *value* side: a `text` column value
carrying a lone surrogate is now rejected at key-encode time (`encodeText` raises, naming
the problem). Identifiers never go through that path — they are encoded directly. This is
the same class of defect one layer up.

## Reproduction (not yet run — reachable from ordinary SQL)

```sql
create table "\uD800" (k integer primary key) using store;   -- name is one lone surrogate
create table "\uD801" (k integer primary key) using store;   -- a different lone surrogate
-- both DDL entries land on the catalog key `EF BF BD`; the second clobbers the first
-- close, reopen: one table is missing
```

**Reachability confirmed by reading the lexer** (`packages/quereus/src/parser/lexer.ts`).
`doubleQuotedIdentifier` and `string` both take the characters between the quotes as a raw
`source.substring(...)` slice — no validation, no escape processing beyond a doubled quote.
So any lone surrogate present in the SQL text (itself an ordinary JavaScript string) reaches
the identifier or the string literal verbatim. This does not need the programmatic schema
APIs.

## Second site: the DDL *text* is mangled too, not only the key

`saveTableDDL` (`store-module.ts`) persists the reconstructed `create table …` text with
`new TextEncoder().encode(ddl)`, and `rehydrateCatalog` reads it back with `TextDecoder`.
Any lone surrogate anywhere in that text — inside a quoted identifier, a `default 'literal'`,
a `check` expression's string constant — is folded to `U+FFFD` on write and comes back as a
different schema than the one that was created. That is silent corruption rather than a
collision, so it needs the same decision (refuse, or escape) but has no `UNIQUE`-style
symptom to notice it by.

## Third site: sync metadata keys

`packages/quereus-sync/src/metadata/keys.ts` builds column-version / tombstone / change-log
keys as `cv:{schema}.{table}:{pk_json}:{column}` and encodes the whole string with
`TextEncoder`. The `{pk_json}` component is safe (it comes from `JSON.stringify`, which
escapes lone surrogates to ASCII), and so are the row payloads. The **identifier**
components — schema, table, column names — are not: two columns whose names differ only in
a lone surrogate share one metadata key. Same class, same fix.

## Expected behavior

Creating two tables with distinct names must never lose one of them, and schema text must
round-trip unchanged. Either the store refuses an identifier it cannot encode faithfully
(the same answer the value path took — a loud error naming the unpaired surrogate, at
`create table` time), or catalog keys and DDL text stop going through `TextEncoder` and use
an escaping that is injective over all JavaScript strings.

Refusing is the cheaper and more consistent option: an identifier that is not valid Unicode
has no business naming a durable object, and the error message can point at the same
explanation the value-side guard already gives.

## Notes

- A `NOTE:` at `buildCatalogKey` in `key-builder.ts` records this and names this ticket.
- Data-store *names* (`buildDataStoreName`) are JavaScript strings, not bytes, so they do
  not collide; only the byte keys do. That is what leaves the orphaned data behind.
- `packages/quereus-store/src/common/encoding.ts` already has a reusable unpaired-surrogate
  detector; whichever direction is taken, it should be the single detector.
