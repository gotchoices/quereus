----
description: Changing a text column's sort/compare rule inside an open transaction ignores the rows that transaction just wrote, so two values that become equal under the new rule can both survive under a uniqueness requirement that forbids them.
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts        # alterColumn → ensureSchemaChangeSafety → rebuildAllSecondaryIndexesStrict
  - packages/quereus/src/vtab/memory/layer/base.ts           # rebuildAllSecondaryIndexesStrict, populateNewIndex, populateIndexFromRows
  - packages/quereus/src/vtab/memory/layer/connection.ts     # hasOpenWork
  - packages/quereus/test/logic/41.7.1-alter-column-collate-unique.sqllogic   # existing committed-rows coverage
  - packages/quereus/test/ddl-in-transaction-validation.spec.ts               # sibling coverage for create index / add constraint
difficulty: medium
----

# `alter column … set collate` in the memory backend does not see the transaction's own rows

## What goes wrong

A `unique` requirement on a text column is enforced using that column's collation — the rule
that decides whether two strings count as the same value. `binary` says `'a'` and `'A'` differ;
`nocase` says they are the same. Changing a column's collation therefore changes which rows
count as duplicates, and the memory backend re-checks uniqueness when the collation changes.

That re-check reads only committed rows. Rows the current transaction has written are skipped,
so the statement is accepted and the duplicates commit:

```sql
create table t (id integer primary key, v text);
create unique index ix on t (v);
begin;
insert into t values (1, 'a');
insert into t values (2, 'A');
alter table t alter column v set collate nocase;   -- accepted; should raise "UNIQUE constraint failed"
commit;
-- table now holds both 'a' and 'A' under a nocase unique index
```

Verified against `main` at the time of writing: no error is raised and `select * from t`
returns both rows.

## Why it survived the sibling fix

`bug-memory-ddl-validation-ignores-pending-rows` closed the same hole for `create unique index`
and `alter table … add constraint … unique` by validating against the DDL connection's
*effective* rows (committed base overlaid with its uncommitted writes). It deliberately scoped
itself to the index/constraint-building paths.

`alter column … set collate` takes a different route: it re-keys and rebuilds the base layer's
secondary indexes via `BaseLayer.rebuildAllSecondaryIndexesStrict`, which walks the base
primary tree. The base tree holds exactly the committed rows, by design — so the rebuild is
structurally blind to the pending ones.

The store backend already validates this case over its effective row stream, so memory and
store now disagree.

## Expected behavior

`alter column … set collate` must reject the statement with `UNIQUE constraint failed` whenever
the new collation makes two of the DDL transaction's *effective* rows collide under a covering
unique index or unique constraint — the same rows a `select` in that transaction would return.
A duplicate the transaction has already deleted must not block the change.

Rejection must leave the schema, the base layer's index map, and the table unchanged, and the
transaction must remain usable — matching what the sibling fix guarantees.

If the statement is accepted, the new collation must stay enforced for the remainder of the
transaction, so a later colliding insert in the same transaction is rejected.

## Notes for whoever picks this up

- The pieces exist. `populateIndexFromRows(rows, index, …, enforceUnique)` in `base.ts` already
  validates a row iterable against a collation-aware index. `MemoryTableManager` already knows
  how to reach the DDL connection's effective rows (`effectiveDdlRows`) and already refuses the
  statement with `BUSY` when a *sibling* connection holds uncommitted writes (`hasOpenWork`),
  so the only rows to worry about are the DDL issuer's own.
- The open design question is whether the strict rebuild should be re-pointed at the effective
  rows, or whether validation should run as a separate pre-pass (as it does for `create index`)
  leaving the base rebuild reading committed rows only. The pre-pass shape is what the sibling
  fix chose, and for a reason: the base's structures are documented to hold exactly the
  committed rows, and a duplicate the transaction has deleted still sits in the base tree.
  Re-keying, though, genuinely does have to touch the base structures.
- The pending layers' inherited indexes are keyed under the *old* collation. Whatever the
  rebuild does to the base, the open transaction's layers need the re-keyed structures too, or
  they will keep comparing under the old rule. See `TransactionLayer.adoptSchema` for the
  mechanism the sibling fix used, and note it only *adds* indexes today.
- `packages/quereus/test/logic/41.7.1-alter-column-collate-unique.sqllogic` covers the
  committed-rows behavior and is cross-module. Extending it with a transactional section would
  fail in store mode until `isolation-ddl-validation-ignores-overlay-rows` lands — the memory
  mocha spec `ddl-in-transaction-validation.spec.ts` is the safe home for the new cases.
