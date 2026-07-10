---
description: Tightening a column to NOT NULL inside an open transaction ignores the rows that transaction just wrote, so a statement that should be rejected is accepted and the table ends up holding a NULL in a column declared to have none.
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts        # alterColumn setNotNull arm — scans baseLayer.primaryTree
  - packages/quereus/src/vtab/memory/layer/manager.ts        # effectiveDdlRows() — the correct row set, already used by the UNIQUE arms
  - packages/quereus-store/src/common/store-module.ts        # alterTable alterColumn setNotNull arm
  - packages/quereus/src/vtab/module.ts                      # EffectiveRowSource — the parameter the isolation layer already threads
difficulty: medium
---

# `alter column … set not null` does not see the transaction's own rows

## What is broken

`alter table t alter column v set not null` is supposed to reject the change when the table
already holds a NULL in `v` (or backfill those rows from the column's DEFAULT first). It only
looks at the rows that have been **committed**. Rows the same transaction has inserted but not
yet committed are invisible to it, so the ALTER is accepted and the transaction goes on to
commit a NULL into a column that now says it cannot hold one.

## Reproduction (confirmed on both backends)

```sql
create table t (id integer primary key, v text null);
begin;
insert into t values (1, null);
alter table t alter column v set not null;   -- expected: rejected. actual: accepted.
```

Verified on the plain memory backend and on the store module behind the isolation layer. The
row survives with `v = null` under a `NOT NULL` column.

## Why it is separate from the UNIQUE case

A sibling ticket (`isolation-ddl-validation-ignores-overlay-rows`, now landed) fixed exactly
this shape of bug for `create unique index` and `alter table … add constraint … unique`. Two
pieces of that work are directly reusable:

*   The memory module already has `effectiveDdlRows()` — the committed rows overlaid with the
    DDL-issuing connection's uncommitted writes. The UNIQUE arms scan it; the `set not null`
    arm still scans `baseLayer.primaryTree` (committed only).
*   For a module wrapped by the isolation layer the pending rows are not in the module at all.
    The layer hands them down through the optional `EffectiveRowSource` parameter on
    `createIndex` / `alterTable`. That parameter already reaches `alterTable`; the `set not
    null` arm simply does not consult it.

So the fix is to route `set not null` through the same row set the UNIQUE arms use, on both
backends. Watch the backfill branch too: when the column has a usable literal DEFAULT the
module backfills the NULL rows rather than rejecting, and a pending row lives in the overlay
where the module cannot write it — the isolation layer's overlay rebuild would have to perform
that backfill, as it already does for `add column`.

## Expected behavior

*   A NULL in any row the issuing transaction can see (committed or its own pending) rejects
    the ALTER with `CONSTRAINT`, leaving the table and the transaction untouched.
*   A NULL only in a row that transaction has already deleted does **not** block the ALTER.
*   With a usable literal DEFAULT on the column, those rows are backfilled instead of
    rejected — pending rows included.
*   A rejection is atomic: nothing is mutated, and the transaction stays usable.

## Scope note

`alter column … set data type` narrows values per row and has the same shape of question
(does a pending row that cannot be converted abort the change?). Worth checking while in here;
it was not probed.
