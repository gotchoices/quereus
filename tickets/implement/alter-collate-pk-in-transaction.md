----
description: Changing the sort/compare rule of a column that is part of a table's primary key, while a transaction has un-committed rows, is accepted and then quietly ignored — the table can end up holding two rows whose keys are supposed to be the same.
prereq: alter-collate-validates-pending-rows
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts        # alterColumn → rebuildPrimaryTreeStrict, effectiveDdlRows
  - packages/quereus/src/vtab/memory/layer/base.ts           # rebuildPrimaryTreeStrict, primaryTree
  - packages/quereus/src/vtab/memory/layer/transaction.ts    # pkFunctions, primaryModifications, adoptSchema
  - packages/quereus/test/ddl-in-transaction-validation.spec.ts
  - packages/quereus/docs/memory-table.md                    # § DDL and transactions
difficulty: hard
----

# `alter column … set collate` on a primary-key column inside an open transaction

Sibling of `alter-collate-validates-pending-rows`, which fixes the same statement for *secondary*
unique indexes and deliberately leaves the primary-key column out of scope. Land that one first —
this ticket builds on the validation pre-pass it introduces.

## What goes wrong

Reproduced against `main`, memory backend:

```sql
create table t (v text primary key);
begin;
insert into t values ('a');
alter table t alter column v set collate nocase;   -- accepted
insert into t values ('A');                        -- accepted; must raise "UNIQUE constraint failed"
commit;
select * from t;                                   -- two rows: 'A' and 'a'
```

And with the duplicate already pending when the change runs:

```sql
create table t (v text primary key);
begin;
insert into t values ('a');
insert into t values ('A');
alter table t alter column v set collate nocase;   -- accepted; must raise "UNIQUE constraint failed"
commit;                                            -- both rows survive
```

## Why

Two mechanisms, both rooted in the change touching only the base layer:

- **Validation blindness.** `BaseLayer.rebuildPrimaryTreeStrict()` walks the base primary tree —
  committed rows only — so a duplicate that exists only in the open transaction is never seen. Same
  shape as the secondary-index bug.
- **Structure swap under a live copy-on-write child.** `rebuildPrimaryTreeStrict()` *replaces*
  `BaseLayer.primaryTree` with a freshly-keyed `BTree` object. The open transaction's
  `TransactionLayer.primaryModifications` was constructed with `{ base: <the old tree object> }`, so
  it keeps reading the old tree, keyed under the old comparator. At `commit` that layer becomes the
  committed head and the re-keyed base tree is dropped on the floor.

`TransactionLayer.pkFunctions` compounds it: they are built once from the layer's creation-time
primary key definition and are explicitly documented as invariant, which is why
`adoptSchema` is not allowed to change them. A primary-key collation change *does* change that
definition.

## The hard part

The base primary tree cannot always represent the post-change state while a transaction is open.
Consider committed rows `'a'` and `'A'`, a transaction that deletes `'A'`, then `set collate nocase`:

- The *effective* rows are collision-free, so the statement must be accepted.
- But the base tree still physically holds both rows, and under the new comparator their keys are
  equal — re-keying the base tree collapses them into one node, losing a row that a
  `rollback` must be able to restore.

So the secondary-index remedy (validate over effective rows, rebuild the base non-enforcing) does not
transfer: a secondary index is a multi-map and tolerates two primary keys under one key; the primary
tree is not.

Options to weigh, none obviously right:

- **Reject with `BUSY`** when the DDL connection holds un-committed writes and the base tree would
  collide under the new comparator. Honest, cheap, and consistent with the existing
  "commit/rollback and retry" posture, but it makes an operation fail for a reason the user cannot
  see in `select` output.
- **Defer the base re-key** until the transaction settles (commit or rollback), holding the new
  comparator only in the schema. Requires the base to serve reads under a comparator that no longer
  matches its key order — probably a non-starter.
- **Rebase the pending layer** onto the re-keyed base, replaying its own writes (the machinery exists:
  `rebaseLayerOntoHead`). Invalidates savepoint snapshots, which `rollback to savepoint` must
  restore — the reason `adoptSchema` exists at all.

Pick one, implement it, and record the tradeoff in the review handoff. Whatever the choice, the
plain-language contract is: **either the statement is rejected with a message the user can act on, or
the new rule is genuinely in force for the rest of the transaction and after it commits.** Silently
accepting the statement and then ignoring it, as today, is the one unacceptable outcome.

## TODO

- Extend the effective-rows validation from `alter-collate-validates-pending-rows` to the primary key:
  build the new primary key comparator from the post-change schema and reject with `CONSTRAINT` when
  two effective rows collide under it.
- Decide and implement the base-tree strategy for the "base holds a collision the transaction has
  deleted" case; document the choice at the call site.
- Make the open transaction's layers use the new primary key collation — `pkFunctions`, the primary
  tree's comparator, and every inherited secondary index's `primaryKeyComparator` / `encode` are all
  derived from it. Note `MemoryIndex`'s doc comment claims "no stale order or encoding survives an
  ALTER"; that is currently false inside a transaction. Fix the code and the comment together.
- Remove the primary-key-column guard the prereq ticket added to `adoptSchemaOnOpenLayers`.
- Tests in `packages/quereus/test/ddl-in-transaction-validation.spec.ts` covering both repros above,
  plus: pending duplicate accepted-then-enforced after `commit`; committed duplicate deleted in the
  transaction; `rollback` restores both rows under the original collation; savepoint snapshot case.
- Confirm `packages/quereus/test/logic/41.7.1-alter-column-collate-unique.sqllogic` (the
  no-transaction primary-key path) still passes.
- Update `packages/quereus/docs/memory-table.md` § *DDL and transactions* to drop the carve-out the
  prereq ticket recorded.
