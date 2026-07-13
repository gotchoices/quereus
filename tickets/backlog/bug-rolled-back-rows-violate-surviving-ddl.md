----
description: If a transaction deletes a duplicate row, then adds a rule forbidding duplicates, and then rolls back, the rule stays but the duplicate row comes back — leaving the table permanently holding data its own constraints say is impossible.
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts   # effectiveDdlRows, validateUniqueOverEffectiveRows, validateRekeyedUniqueStructures
  - packages/quereus/src/vtab/memory/layer/transaction.ts
  - packages/quereus/test/ddl-in-transaction-validation.spec.ts
  - docs/memory-table.md                                # § DDL and transactions
difficulty: hard
----

# Rolled-back rows can violate the schema change that outlived them

## What happens

Schema changes in Quereus are not part of the surrounding transaction: a `rollback` does not
undo a `create index` or an `alter table`. That *is* now the decided contract for the memory
backend — `feat-ddl-transaction-capability` settled it as the `'non-transactional'` tier, and
raising memory to the fully-transactional tier is the separate backlog ticket
`feat-transactional-ddl-native-backends`.

Separately — and correctly, per `docs/memory-table.md` § DDL and transactions — a schema change
that has to inspect existing rows now inspects the rows *the issuing transaction can see*: the
committed rows, plus that transaction's own uncommitted inserts, minus its own uncommitted
deletes.

Put those two facts together and the deletes can be taken back while the rule they justified
stays in force. The table is then holding rows that its own schema forbids, and nothing will
ever notice.

## Reproductions

Both run on the memory backend, on `main` at the time of writing.

**A. `create unique index`, undone by `rollback to savepoint`:**

```sql
create table t (id integer primary key, v text);
insert into t values (1, 'a');
begin;
  insert into t values (2, 'a');   -- duplicate, uncommitted
  savepoint s;
  delete from t where id = 2;      -- duplicate gone, from this transaction's point of view
  create unique index ix on t (v); -- accepted: only one 'a' is visible
  rollback to s;                   -- row 2 is back
commit;
-- t now holds ('a'), ('a') under a UNIQUE index on v.
```

**B. `alter column … set collate`, undone by a whole-transaction `rollback`:**

```sql
create table t (id integer primary key, v text);
create unique index ix on t (v);
insert into t values (1, 'a'), (2, 'A');   -- distinct under BINARY
begin;
  delete from t where id = 2;
  alter table t alter column v set collate nocase;  -- accepted: only 'a' is visible
rollback;
-- The column is still NOCASE and the index is still keyed NOCASE, but row 2 ('A') is back.
```

Case B is a behavior change: before the pending-rows work landed, the collation change
re-checked the committed rows directly and would have refused this ALTER. Refusing it was
also wrong (it blocks the legal case where the transaction really does commit the delete),
so this is not a matter of reverting anything.

## Why it matters

The end state is silent and durable. A unique index that holds duplicate keys will happily
serve both rows to a scan, and a later `insert` of a third `'a'` may be accepted or rejected
depending on which candidate the enforcement path happens to compare. Nothing re-validates,
because from the engine's point of view the constraint was already validated.

## What a fix has to decide

The semantics question is settled (`feat-ddl-transaction-capability`): memory stays on the
`'non-transactional'` tier for now, so "make the schema change roll back too" is **not** this
bug's fix — that is `feat-transactional-ddl-native-backends`, a separate, much larger effort.
Within the settled contract, two candidate fixes remain:

- **Recommended:** re-validate the affected structures at `rollback to savepoint` (and at
  whole-transaction `rollback`) when row-validating DDL ran inside the transaction, paying an
  extra scan for a rare statement shape. Accepts every legal case; the only cost lands on the
  transaction that actually created the hazard.
- Or: refuse row-validating DDL when the issuing transaction has uncommitted *deletes* on the
  table — the narrowest rule that closes the hole, at the cost of rejecting a legal case.

An interim mitigation already exists: `pragma ddl_transaction_policy = 'strict'` (from
`feat-ddl-transaction-capability`) refuses the DDL inside the transaction outright, which
closes this hole for applications that opt in — but the default remains permissive, so the
bug still needs a fix.

Whichever is chosen, `docs/memory-table.md` § DDL and transactions needs updating; it currently
carries a paragraph pointing here.
