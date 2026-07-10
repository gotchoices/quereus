---
description: Two persistent tables whose quoted names differ only by a broken half-character end up sharing one catalog entry, so one of them silently disappears when the database is reopened.
files:
  - packages/quereus-store/src/common/key-builder.ts   # buildCatalogKey / buildViewCatalogKey / buildMaterializedViewCatalogKey / buildStatsKey
  - packages/quereus-store/src/common/store-module.ts  # rehydrateCatalog — the reader that loses the entry
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

## Reproduction (not yet run — believed reachable from ordinary SQL)

```sql
create table "\uD800" (k integer primary key) using store;   -- name is one lone surrogate
create table "\uD801" (k integer primary key) using store;   -- a different lone surrogate
-- both DDL entries land on the catalog key `EF BF BD`; the second clobbers the first
-- close, reopen: one table is missing
```

Worth confirming the parser accepts a quoted identifier containing a raw lone surrogate
before deciding how much this matters. If it does not, the defect is only reachable through
the programmatic schema APIs, and the priority drops accordingly.

## Expected behavior

Creating two tables with distinct names must never lose one of them. Either the store
refuses an identifier it cannot encode faithfully (the same answer the value path took —
a loud error naming the unpaired surrogate, at `create table` time), or catalog keys stop
going through `TextEncoder` and use an escaping that is injective over all JavaScript
strings.

Refusing is the cheaper and more consistent option: an identifier that is not valid Unicode
has no business naming a durable object, and the error message can point at the same
explanation the value-side guard already gives.

## Notes

- A `NOTE:` at `buildCatalogKey` in `key-builder.ts` records this and names this ticket.
- Data-store *names* (`buildDataStoreName`) are JavaScript strings, not bytes, so they do
  not collide; only the byte keys do. That is what leaves the orphaned data behind.
- `packages/quereus-store/src/common/encoding.ts` already has a reusable unpaired-surrogate
  detector; whichever direction is taken, it should be the single detector.
