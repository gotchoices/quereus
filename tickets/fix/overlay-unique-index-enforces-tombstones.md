---
description: Inside a transaction, deleting a row and inserting a different one can be wrongly rejected as a duplicate, because the deletion marker left behind is treated as if it were a real row by the unique-index check.
files:
  - packages/quereus-isolation/src/isolation-module.ts   # createOverlaySchema — copies the underlying's indexes verbatim onto the overlay
  - packages/quereus-isolation/src/isolated-table.ts     # ensureOverlay; tombstone-insert branch of update()
  - packages/quereus-isolation/src/overlay-rows.ts       # OverlayEntry — documents the tombstone row shape
  - packages/quereus-store/test/isolated-store.spec.ts   # nearest existing coverage
difficulty: medium
---

# The isolation overlay's UNIQUE indexes are enforced against deletion markers

## Background, in plain terms

The isolation layer gives each connection a private staging table — an *overlay* — holding the
rows that connection has written but not yet committed. A row the connection **deleted** is
staged as a *tombstone*: a row carrying the deleted row's primary key and `NULL` in every other
column, plus a flag column marking it as a deletion.

The overlay is created with a copy of the real table's schema, deletion-flag column appended.
That copy includes the real table's secondary indexes — **including their `UNIQUE` flag**. So
the overlay's storage enforces uniqueness across every staged row, and it cannot tell a
tombstone from a live row.

## Why this is usually invisible

A tombstone has `NULL` in every non-primary-key column. SQL treats NULLs as distinct for
uniqueness, so a UNIQUE index over an ordinary (non-PK) column never sees a tombstone as a
duplicate. That is luck, not design.

The luck runs out when **every column of the UNIQUE index is also a primary-key column**.
Tombstones carry real PK values, so two tombstones — or a tombstone and a live row — collide.

## Reproductions

Both against the isolated store module (`createIsolatedStoreModule`); the same shape holds for
any underlying, since the defect lives entirely in the overlay.

**1. Spurious UNIQUE failure on delete-then-reinsert.** Nothing here involves DDL inside the
transaction; the index predates it. This fails today on `main`.

```sql
create table t (a integer, b integer, primary key (a, b));
create unique index t_a_ux on t (a);
insert into t values (1, 1);

begin;
  delete from t where a = 1 and b = 1;
  insert into t values (1, 2);   -- rejected: UNIQUE constraint failed: _overlay_t_2 (a)
```

The insert is legal — the only row with `a = 1` was just deleted — but the overlay still holds
the tombstone `(1, 1)`, whose `a` is `1`.

**2. INTERNAL error out of `create unique index` inside a transaction.** The overlay rebuild
that `IsolationModule.createIndex` performs re-inserts every staged row under the new schema;
two tombstones collide, the rebuild raises `CONSTRAINT`, and the issuer-side guard maps that to
`StatusCode.INTERNAL` ("validation and migration have drifted").

```sql
create table t (a integer, b integer, primary key (a, b));
insert into t values (1, 1);
insert into t values (1, 2);

begin;
  delete from t;                       -- two tombstones, both a = 1
  create unique index t_a_ux on t (a); -- INTERNAL: overlay rebuild hit a unique constraint
```

The DDL's own validation pass correctly saw an empty effective row set and accepted the index.
Only the migration disagreed — because it judged tombstones as rows.

## Expected behavior

*   A tombstone is a deletion marker, not a row. No uniqueness rule may be evaluated over it.
*   Reproduction 1 must insert `(1, 2)` successfully and commit.
*   Reproduction 2 must create the index successfully and commit an empty table.
*   Everything the current overlay indexes are relied on for must keep working: the merged
    secondary-index scan path (`IsolatedTable.queryViaSecondaryIndex`, which wants only the
    *live* overlay rows from the index), and enforcement of a newly created UNIQUE index against
    further writes in the same transaction (`10.1.2-ddl-in-transaction.sqllogic` §4 and §5).

## Notes for whoever picks this up

The obvious lever is `IsolationModule.createOverlaySchema`, which copies `baseSchema.indexes`
verbatim. Making the overlay's copy of each index *partial* — restricted to rows whose deletion
flag is `0` — would express exactly the intended semantics, and `queryViaSecondaryIndex` already
wants only live rows out of that index. Whether the overlay's primary-key uniqueness (which
*must* still cover tombstones, so a re-insert at a tombstoned PK is detected) survives that
change needs checking; the PK is not one of the copied secondary indexes, so it probably does.

A `KNOWN DEFECT:` comment sits on `createOverlaySchema` pointing here. Remove it with the fix.

Coverage to add: both reproductions above, plus the non-PK-column case (which passes today) so
the fix cannot regress it, plus a partial-index case if the chosen fix introduces predicates.
