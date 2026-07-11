----
description: Dropping a unique index inside an open transaction does not take effect until the transaction ends — rows the transaction inserts afterwards are still rejected as duplicates, even though the constraint no longer exists.
files:
  - packages/quereus/src/vtab/memory/layer/transaction.ts  # adoptSchema — adds indexes, never removes them
  - packages/quereus/src/vtab/memory/layer/manager.ts      # dropIndex, dropConstraint, adoptSchemaOnOpenLayers
  - packages/quereus/src/vtab/memory/layer/connection.ts   # savepoint stack
difficulty: medium
----

# `DROP INDEX` / `DROP CONSTRAINT` inside a transaction keeps enforcing

## Reproduction (memory backend, confirmed on `main`)

```sql
create table t (id integer primary key, v text);
create unique index ix on t (v);
begin;
insert into t values (1, 'a');
drop index ix;
insert into t values (2, 'a');   -- rejected: "UNIQUE constraint failed: t (v)"
```

The second insert should be accepted: the index — and the UNIQUE constraint derived from
it — no longer exist. `alter table t drop constraint u` is expected to behave the same way.

This is not new. It is the mirror image of the already-fixed
`bug-memory-ddl-validation-ignores-pending-rows`: a transaction's layers capture the table
schema when they are created, so a schema change made mid-transaction is invisible to them.
The *additive* half of that (a new index/constraint the transaction failed to enforce) is
fixed; the *subtractive* half (a removed index/constraint the transaction keeps enforcing)
is not.

No data is corrupted — the failure mode is a spurious rejection, never a duplicate row
sneaking in. That is why it is filed here rather than as urgent work.

## What already exists

`TransactionLayer.adoptSchema(newSchema)` hands a new schema to an open transaction's layers
and builds any index the new schema adds. `MemoryTableManager.adoptSchemaOnOpenLayers` applies
it across the pending layer and every savepoint snapshot beneath it, and `createIndex` /
`addUniqueConstraint` call it. `dropIndex` and `dropConstraint` do not, and `adoptSchema` has
no removal path.

## The part that needs a decision, not just code

Making `adoptSchema` drop an index from a layer is a few lines. The question is what a
savepoint should do:

```sql
begin;
insert into t values (1, 'a');
savepoint s;
drop index ix;
rollback to s;                   -- is `ix` enforced again?
```

Under SQL semantics, rolling back to a savepoint undoes the drop, so `ix` should be enforced
again. But `adoptSchemaOnOpenLayers` deliberately rewrites *every* layer in the savepoint
chain (that is what makes the additive case survive a `rollback to savepoint`), so a naive
removal would leave the index gone in the restored snapshot too. Getting this right probably
means recording the schema alongside each savepoint entry rather than mutating the chain.

Note also that the memory module's DDL is not transactional at all today — a plain `rollback`
after `drop index` does not bring the index back either (see `docs/memory-table.md` § DDL and
transactions, and `feat-ddl-transaction-capability` in this folder). Whoever picks this up
should decide how far to go: fixing only in-transaction *enforcement* is a small, contained
change; making DDL genuinely reversible is the larger feature.

## Expected behavior

- After `drop index` / `drop constraint` inside a transaction, later statements in that same
  transaction are no longer checked against the dropped constraint, and index scans no longer
  choose the dropped index.
- The same holds for the store backend and behind the isolation layer.
