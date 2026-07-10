----
description: Changing the sort/compare rule of a primary-key column inside an open transaction used to be accepted and then quietly ignored, letting a table end up with two rows that should have been duplicates; it now either takes effect for real or is rejected with a message the user can act on.
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts        # validateRekeyedPrimaryKey, assertNoPrimaryKeyCollision, alterColumn, adoptSchemaOnOpenLayers
  - packages/quereus/src/vtab/memory/layer/transaction.ts    # rekeyPrimaryKey, reindexNetWrites
  - packages/quereus/src/vtab/memory/layer/base.ts           # rebuildPrimaryTreeStrict (doc only)
  - packages/quereus/src/vtab/memory/index.ts                # MemoryIndex.primaryKeyComparator doc
  - packages/quereus/test/ddl-in-transaction-validation.spec.ts
  - docs/memory-table.md                                     # § DDL and transactions, rule 3
difficulty: hard
----

# Review: `alter column … set collate` on a primary-key column inside an open transaction

## What the statement now does

Both original repros are fixed, and neither is silently accepted-then-ignored:

```sql
create table t (v text primary key);
begin;
insert into t values ('a');
alter table t alter column v set collate nocase;   -- accepted, genuinely in force
insert into t values ('A');                        -- CONSTRAINT: UNIQUE constraint failed
commit;
select * from t;                                   -- one row: 'a'
```

```sql
create table t (v text primary key);
begin;
insert into t values ('a');
insert into t values ('A');
alter table t alter column v set collate nocase;   -- CONSTRAINT: UNIQUE constraint failed
```

## The design decision, and its cost

The ticket asked for a choice among three strategies. **Reject with `BUSY`** was taken, for the
"base holds a collision the transaction has deleted" case and every analogue of it.

The reason the other two were rejected: the primary tree is a *map*, not a multi-map, so unlike a
secondary index it cannot physically hold two rows whose keys collapse under the new comparator.
Every layer in the DDL connection's chain — the committed base, savepoint snapshots, and the
immutable layer each statement boundary leaves behind — holds rows that a `rollback` or
`rollback to savepoint` must be able to restore. Deferring the re-key would mean serving reads
from a tree whose key order disagrees with its comparator; rebasing would discard the savepoint
snapshots that `rollback to savepoint` restores.

So `MemoryTableManager.validateRekeyedPrimaryKey` runs before any mutation and checks *every*
layer, not just the effective view:

| what collides under the new comparator | result |
| --- | --- |
| the transaction's effective rows | `CONSTRAINT` — `UNIQUE constraint failed: <table> primary key collides under new collation` |
| any layer beneath them | `BUSY` — `Cannot change the collation of a primary key column of table <t>: rows this transaction has removed still collide under the new collation and must survive a rollback. Commit/rollback and retry.` |

Once that passes, `BaseLayer.rebuildPrimaryTreeStrict` re-keys the base and the new
`TransactionLayer.rekeyPrimaryKey` re-keys each open layer oldest-first: `pkFunctions`, the
primary tree, and *every* secondary index (each derives its `primaryKeyComparator` / `encode`
from the primary key definition). `adoptSchema` keeps its old job; the PK path no longer routes
through it, and the guard the prereq ticket added is gone.

**The known cost, stated plainly.** The `BUSY` arm is conservative. The layer chain holds one
immutable layer per statement boundary (`MemoryTableConnection.createSavepoint`'s eager path
fires for every statement inside a transaction), so a transaction that held a colliding pair at
*any* statement boundary is refused — even when its final view is clean and no savepoint can
reach the offending layer:

```sql
begin;
insert into t values ('a');
insert into t values ('A');                        -- both resident at this boundary
delete from t where v = 'a';                       -- effective view is now clean
alter table t alter column v set collate nocase;   -- BUSY anyway
```

This is a false rejection, not a wrong answer: the transaction stays usable, and committing then
re-issuing the ALTER succeeds. Narrowing it would mean re-parenting the view's tree past the
unreachable layers — precisely the rebase savepoint snapshots exist to prevent. **A reviewer who
thinks that trade is wrong should say so; it is the one judgement call in this change.**

## Where to look hardest

*   **`TransactionLayer.rekeyPrimaryKey`'s replay** (`transaction.ts`). Own-writes are replayed
    by **net effect per key, deletions before upserts**, not in log order. Two keys that were
    distinct in the write log can collapse under the new comparator, so a verbatim replay can let
    a deletion take a surviving row with it. Its soundness leans entirely on the "no layer holds
    a collision" precondition — if that check is ever weakened, this replay breaks silently.
*   **`TransactionLayer.reindexNetWrites`** exists because `reindexOwnWrites` cannot be reused:
    the latter reads each touched key back out of the layer's primary tree, and under the new
    comparator a *deleted* key resolves to a *different* row the layer upserted, filing that row
    in the index under both primary keys. It is reachable and it is covered — the test
    *"does not double-index a row whose old and new primary keys collapse"* returns the row twice
    from an index scan if `reindexNetWrites` is swapped back to `reindexOwnWrites` (verified by
    doing exactly that). It needs a single layer with both a delete and an upsert, i.e. one
    `update` that moves the primary key onto the colliding value *and* changes an index key.
*   **The `catch` in `alterColumn`** now restores `baseLayer.primaryTree` as well as the schema.
    With both pre-passes running before any mutation, nothing below `updateSchema` is expected to
    throw, so this path is untested. If `rekeyPrimaryKey` on layer *k* of a chain threw, layers
    `0..k-1` would already be re-keyed and the restore would not undo them.

## Tests

`packages/quereus/test/ddl-in-transaction-validation.spec.ts`, new describe block
*"alter column … set collate on a PRIMARY KEY column"* (12 cases): both repros; enforcement for
the rest of the transaction and after commit; `BUSY` for a committed duplicate the transaction
deleted, for a statement-boundary-only collision, and for a duplicate held in an eager savepoint
snapshot; `rollback` restoring the pre-transaction rows under the surviving collation;
`rollback to savepoint` with the new collation still enforced; a row moved onto the colliding key
by `update`; the double-indexing regression above; secondary-index survival across a PK re-key; a
composite PK re-keyed on its second column.

`yarn workspace @quereus/quereus run lint` clean. `yarn test` (whole workspace) green — quereus
6763 passing / 0 failing, including
`test/logic/41.7.1-alter-column-collate-unique.sqllogic` (the no-transaction PK path, which still
raises `CONSTRAINT` because with no open layers the base *is* the effective view).

### Gaps I did not close

*   **Store backend untouched.** This is the memory manager only. `yarn test:store` was not run
    (the store's own pending-rows hole is `fix/bug-store-alter-rekey-ignores-pending-ops`), and
    the isolation overlay hole is `fix/isolation-ddl-validation-ignores-overlay-rows`. Nothing in
    this diff touches either path.
*   **No partial-index-over-a-PK-re-key test.** `reindexNetWrites` honors
    `rowMatchesPredicate`, but nothing exercises a partial index while the primary key is being
    re-keyed.
*   **No `desc` primary-key test.** `createPrimaryKeyFunctions` folds `desc` into the comparator
    and the re-key inherits that; unverified.
*   **Multi-connection is unreachable, not tested.** `ensureSchemaChangeSafety` already raises
    `BUSY` when a sibling connection holds open work, so a PK re-key never sees a foreign layer.
    The pre-existing "other connections" tests cover that gate.
*   **`validateRekeyedUniqueStructures`'s MV caveat is unchanged.** It walks `schema.indexes`, so a
    UNIQUE constraint covered only by a row-time materialized view would not be re-checked. Still
    guarded by the always-present auto-index; the existing `NOTE` says so.

### Tripwire parked in code

*   `MemoryTableManager.assertNoPrimaryKeyCollision` walks every row of every layer, so validating
    a chain is O(layers × rows) — one more full pass than the base rebuild that follows. Fine for
    a statement this rare. A `NOTE:` at the method says what to do if a deep savepoint stack over a
    large table ever makes an ALTER slow (a layer's rows differ from its parent's only at the keys
    it wrote, so the walk can be narrowed to those).

### Adjacent behavior worth knowing

`tickets/backlog/bug-rolled-back-rows-violate-surviving-ddl.md` describes rolling back rows that
the surviving DDL forbids. **The primary-key arm of that bug is now closed by construction**: the
rows a rollback can restore are exactly the rows of some layer, and every layer was proved
collision-free before the ALTER was allowed. The secondary-index arm (case A and case B of that
ticket) is untouched and still open.
