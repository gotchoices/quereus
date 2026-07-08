description: The isolation layer crashes on tables whose primary key is a big integer, produces duplicate rows when a case-insensitive key changes case, and can corrupt data when an insert reuses a key that was just deleted in the same transaction.
files:
  - packages/quereus-isolation/src/isolated-table.ts   # lines ~391 (modified-PK set), ~716 (tombstone-revival insert)
  - docs/design-isolation-layer.md                      # checkMergedUniqueConstraints, checkMergedPKConflict (lines ~395-439)
difficulty: medium
----

## Problem

Three related robustness defects in how the isolation layer tracks and merges pending
per-connection changes, all rooted in `isolated-table.ts`:

**1. `JSON.stringify(pk)` crashes on bigint primary keys.**
The set that tracks which primary keys have pending modifications keys its entries with
`JSON.stringify(pk)` (`isolated-table.ts:391`). `JSON.stringify` throws `TypeError: Do
not know how to serialize a BigInt` on a bigint value. Any secondary-index scan while a
transaction has pending changes on a table with a bigint PK therefore crashes. Bigint
PKs are legitimate (the type system supports them), so this is a hard failure on a
supported case.

**2. The modified-PK key ignores collation, so NOCASE PK case-changes duplicate rows.**
The same string key does not account for the PK column's collation. For a `NOCASE`
(case-insensitive) primary key, changing a row's PK from `"abc"` to `"ABC"` is logically
the *same* key, but the two produce different `JSON.stringify` strings. The merge then
treats them as two distinct rows and the scan yields duplicates.

**3. Reviving a same-transaction tombstone skips the UNIQUE check.**
When an INSERT reuses a primary key that was deleted (tombstoned) earlier in the *same*
transaction, the code takes an early-return path (`isolated-table.ts:716`) that revives
the row **without** calling `checkMergedUniqueConstraints`, then flushes it with
`trustedWrite: true`. If the revived row collides with a non-PK UNIQUE constraint, the
collision is never detected here: it either surfaces as an opaque INTERNAL error at
commit time, or — worse — corrupts the store because the trusted write bypasses the
underlying's own checks.

## Expected behavior

- Secondary-index scans with pending changes on a bigint-PK table complete normally.
- The modified-PK identity must be **collation-aware**: two PK values equal under the
  key's collation (e.g. `"abc"` vs `"ABC"` under NOCASE) map to the same entry, so the
  merge yields exactly one row.
- Reviving a same-transaction tombstone must run the same merged UNIQUE-constraint check
  (`checkMergedUniqueConstraints`) as any other insert before flushing, so UNIQUE
  collisions are detected and reported as proper constraint violations rather than
  INTERNAL errors or silent corruption.

## Investigation / direction

- Replace the `JSON.stringify(pk)`-based key with a serialization that (a) handles
  bigint and (b) respects the PK columns' collation — presumably the same canonical
  key-encoding the engine already uses for keyed addressing, rather than JSON. Check how
  PK keys are canonicalized elsewhere in the isolation layer and in the store adapters
  to stay consistent (there is a related `1-json-canonical-key-hashing` backlog item —
  reuse an existing canonical encoder if one exists).
- Route the tombstone-revival insert path through `checkMergedUniqueConstraints` before
  it flushes with `trustedWrite: true`.
- Reproducing tests to add: a secondary-index scan over a bigint-PK table with a pending
  change (currently throws); a NOCASE-PK case-change scan asserting a single merged row;
  an insert reviving a same-transaction tombstone that collides on a non-PK UNIQUE,
  asserting a clean constraint error rather than INTERNAL/corruption.
