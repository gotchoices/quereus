---
description: In a persistent-store table, a primary key column declared with the flexible `any` or `json` type treats text case-insensitively when deciding whether two rows are duplicates. Inserting two rows whose keys differ only in letter case is rejected as a duplicate, even though the database considers them different values.
files:
  - packages/quereus-store/src/common/store-table.ts               # resolvePkKeyCollations — returns undefined for non-isTextual columns
  - packages/quereus-store/src/common/encoding.ts                  # buildDataKey / encodeKey — an undefined per-column collation falls back to options.collation (K)
  - packages/quereus-store/src/common/store-module.ts              # reconcilePkCollations — only touches isTextual PK members
difficulty: medium
---

# `any` / `json` primary-key columns are keyed under the table collation but compared under BINARY

## What goes wrong

A store table has a **table key collation** `K`, defaulting to `NOCASE`. Each primary-key
column's key bytes are supposed to be encoded under that column's own collation.
`resolvePkKeyCollations` (`store-table.ts`) computes that per-column collation, but returns
`undefined` for any column whose logical type is not *textual* — which includes `any` and
`json`, both of which can perfectly well hold a text value.

`undefined` is not "encode type-natively". Down in `encoding.ts`, `buildDataKey` reads an
`undefined` per-column entry as *"fall back to `options.collation`"* — i.e. to `K`. So a
text value in an `any` primary-key column is normalized with `NOCASE`'s
`toLowerCase()` before it becomes key bytes, and a `json` value has `toLowerCase()` applied
to its entire canonical JSON string.

Meanwhile nothing tells the engine that. `reconcilePkCollations` (`store-module.ts`) only
adjusts PK members whose logical type is textual, so an `any` / `json` column keeps the
engine's default `BINARY` comparison collation. Uniqueness is therefore *enforced* under
`NOCASE` and *compared* under `BINARY`.

## Reproduction

```sql
create table t (k any primary key, v text) using store;
insert into t values ('A', 'upper');
insert into t values ('a', 'lower');   -- ConstraintError: UNIQUE constraint failed: t PK.
```

A memory table accepts both rows, because `'A'` and `'a'` are distinct under `BINARY`. The
same happens with `json`:

```sql
create table t (j json primary key, v text) using store;
insert into t values ('{"A":1}', 'upper');
insert into t values ('{"a":1}', 'lower');   -- ConstraintError: UNIQUE constraint failed: t PK.
```

Here the two JSON objects have different keys, are unequal by any reasonable JSON
comparison, and still collide — the collation normalizer ran over the serialized JSON text.

The failure surfaces as a spurious rejected insert, which is the benign direction. The
concerning direction is whether any code path can *overwrite* rather than reject. That
should be checked as part of the fix.

## Related, already-mitigated symptom

The recently-landed order-preservation gate (`store-range-seek-order-preserving-gate`)
noticed the same divergence from the read side: because the column's key collation (`K`) and
its comparison collation (`BINARY`) differ, `pkOrderPreservingPrefixLength` now refuses to
build a byte-range window or advertise primary-key order for such a member. That prevents
range seeks from dropping rows on these columns, but it is a symptom guard, not the fix —
uniqueness enforcement still uses the wrong bytes, and the guard costs the seek even for the
tables where the underlying encoding is in fact fine.

The stale comment that claimed these columns "stay BINARY-keyed *and* BINARY-compared" has
been corrected in `resolvePkKeyCollations` and now points here.

## Expected behavior

A primary-key column that the engine compares under `BINARY` must have its key bytes encoded
under `BINARY`. A store table's `any` and `json` primary-key columns must accept exactly the
row sets a memory table accepts.

Once key bytes and comparison collation agree for these columns, the read-side guard should
stop declining their range seeks and primary-key ordering advertisement of its own accord —
worth confirming with the tests in
`packages/quereus-store/test/collation-order-preserving.spec.ts` (the test named
"declines the PK RANGE seek on an `any` PK…" encodes today's behavior and will need to be
inverted).

## Migration concern

This changes the physical key bytes of existing `any` / `json` primary-key columns in
already-written stores. Reopening such a store after the fix would look for rows under bytes
that were never written. The fix must say what happens to existing data — a rebuild, a
version stamp, or an explicit statement that no such tables exist in the wild yet.
