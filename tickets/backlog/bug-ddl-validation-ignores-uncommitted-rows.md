----
description: When you create an index or add a UNIQUE constraint while a transaction is still open, the check for existing duplicate rows only looks at rows that were already committed — rows you inserted a moment ago inside the same transaction are invisible, so duplicates can slip through.
files:
  - packages/quereus/src/vtab/memory/manager.ts          # populateNewIndex — reads the committed layer
  - packages/quereus-store/src/common/store-module.ts    # validateUniqueOverExistingRows (~1064) — raw dataStore.iterate
  - packages/quereus-store/src/common/store-module.ts    # createIndex (~786) — already fixed to read effective rows
difficulty: medium
----

# DDL that validates existing rows does not see uncommitted rows

## What happens

Two pieces of DDL inspect the table's current contents before they take effect:

- `CREATE UNIQUE INDEX` — must reject if the existing rows already contain a duplicate.
- `ALTER TABLE … ADD CONSTRAINT … UNIQUE` — same.

Both read only the **committed** rows. Any row written earlier inside a still-open
transaction is skipped. Reproduced against the in-memory backend:

```sql
create table t (id integer primary key, v text);
begin;
insert into t values (1, 'a');
create unique index ix on t (v);   -- succeeds; should see row 1
insert into t values (2, 'a');     -- ACCEPTED; a duplicate now exists under a UNIQUE index
```

After `commit`, the table holds two rows with `v = 'a'` under a constraint that
forbids it. Nothing errors, at any point.

The persistent store backend had the identical hole in `createIndex`; the review of
`store-unique-check-via-index` fixed that one call site by building the new index
from the table's *effective* rows (committed merged with the open transaction's
pending writes). The remaining two sites are the memory backend's `populateNewIndex`
and the store's `validateUniqueOverExistingRows` (the `ADD CONSTRAINT UNIQUE` /
`SET COLLATE` validator).

## Expected behavior

Row-validating DDL should see exactly the rows a `select` in the same transaction
would see. `CREATE UNIQUE INDEX` and `ADD CONSTRAINT … UNIQUE` must fail with a
`UNIQUE constraint failed` error when the transaction's own uncommitted rows already
violate the constraint, and must otherwise index/accept those rows.

## Also worth deciding

This is really one instance of a broader question the codebase has not answered:
**what are the transaction semantics of DDL?** Today an index's catalog entry and its
key-value store are written immediately, outside the transaction coordinator, so a
`rollback` does not undo a `create index`. That is tolerable (the readers all
re-validate each index entry against the live row, so a leftover entry can never
manufacture a result), but it should be a deliberate, documented choice rather than an
accident. A decision here — DDL is auto-committing, versus DDL participates in the
transaction — bounds how much of the above needs fixing.
