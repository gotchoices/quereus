----
description: Tightening a column to reject empty values, or changing its data type, while a transaction has un-committed rows, checks and converts only the older rows — the transaction's own rows slip through unchecked, and after it commits the conversion is lost entirely.
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts        # alterColumn: setNotNull and setDataType branches
  - packages/quereus/src/vtab/memory/layer/base.ts           # primaryTree
  - packages/quereus/src/vtab/memory/layer/transaction.ts    # tableSchemaAtCreation, primaryModifications
difficulty: medium
----

# `alter column set not null` / `set data type` ignore the issuing transaction's rows

Same root cause as `alter-collate-validates-pending-rows`, different attributes of the same
statement. That ticket covers `set collate` only; these two were found while reproducing it and are
left here for triage rather than folded in.

In the memory backend, committed rows live in a **base layer** and an open transaction's writes live
in a **transaction layer** stacked on top. Every row-touching branch of
`MemoryTableManager.alterColumn` reads and writes `baseLayer.primaryTree` directly, so it neither
sees nor updates the open transaction's rows. The transaction layer additionally freezes its schema
at construction, so it keeps the pre-change column definition — and at `commit` that layer becomes
the committed head, discarding the base's changes.

All three behaviors below were reproduced against `main`.

**A `NULL` the transaction wrote survives a `set not null`:**

```sql
create table t (id integer primary key, v text null);
begin;
insert into t values (1, null);
alter table t alter column v set not null;   -- accepted; must raise "column v contains NULL values"
commit;
select * from t;                             -- (1, null), in a NOT NULL column
```

**An unconvertible value the transaction wrote survives a type change:**

```sql
create table t (id integer primary key, v text);
begin;
insert into t values (1, 'notanumber');
alter table t alter column v set data type integer;   -- accepted; must be rejected
commit;
select * from t;                                      -- (1, 'notanumber'), in an integer column
```

**And a type change that *should* succeed is silently thrown away.** Here the conversion of the
committed row is applied to the base tree, but the pending layer's copy-on-write view was snapshotted
before it, so after `commit` neither row is converted:

```sql
create table t (id integer primary key, v text);
insert into t values (1, '42');
begin;
insert into t values (2, '7');
alter table t alter column v set data type integer;
commit;
select typeof(v) from t;   -- 'text', 'text' — both rows still text
```

## Expected behavior

A row-validating `alter column` must check the transaction's *effective* rows — the rows a `select`
in that transaction would return — and reject when any of them violates the new definition. When it
is accepted, the new definition and any row conversion it implies must hold for the rest of the
transaction and survive `commit`. Rejection must leave the schema and the table unchanged, with the
transaction still usable.

`set default` is metadata-only and needs no row pass, but it does share the stale-schema problem: the
open transaction keeps the old default for its remaining statements. Worth confirming and covering.

## Notes

`MemoryTableManager` already has the pieces the sibling fixes use: `effectiveDdlRows()` yields the
DDL connection's effective rows, `ensureSchemaChangeSafety()` already raises `BUSY` when a *different*
connection holds un-committed writes (so only the issuer's own rows matter), and
`adoptSchemaOnOpenLayers` / `TransactionLayer.adoptSchema` is the mechanism for handing a new schema
to the open layers. What has no precedent here is mutating the transaction layer's rows (the type
conversion), which the collation work does not need.

Check the store backend's behavior for the same statements before settling on the memory contract —
memory and store are expected to agree.
