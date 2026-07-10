----
description: On in-memory tables, creating a unique index or adding a UNIQUE constraint inside an open transaction ignores rows the transaction just inserted, and afterwards the transaction stops enforcing the new constraint at all — so duplicate rows end up committed under a constraint that forbids them.
prereq: bug-store-add-constraint-unique-ignores-pending-rows
files:
  - packages/quereus/src/vtab/memory/layer/base.ts        # populateNewIndex (~366), addIndexToBase (~349)
  - packages/quereus/src/vtab/memory/layer/manager.ts     # createIndex (~2150), addUniqueConstraint (~2510), ensureSchemaChangeSafety (~2622), lookupEffectiveRow, rebaseLayerOntoHead (~573)
  - packages/quereus/src/vtab/memory/layer/transaction.ts # tableSchemaAtCreation, initializeSecondaryIndexes (~122)
  - packages/quereus/src/vtab/memory/layer/connection.ts  # MemoryTableConnection: pendingTransactionLayer, savepointStack
  - packages/quereus/src/vtab/memory/index.ts             # MemoryIndex
  - packages/quereus/test/logic/10.1-ddl-lifecycle.sqllogic
difficulty: hard
----

# Memory backend: index-building DDL is blind to the open transaction

## Reproduction (confirmed on `main`)

```ts
await db.exec(`create table t (id integer primary key, v text)`);
await db.exec(`begin`);
await db.exec(`insert into t values (1, 'a')`);
await db.exec(`create unique index ix on t (v)`);   // succeeds — should raise UNIQUE constraint failed
await db.exec(`insert into t values (2, 'a')`);     // ACCEPTED
await db.exec(`commit`);
// select * from t  ⇒  {id:1,v:'a'}, {id:2,v:'a'}   ← duplicates under a UNIQUE index
```

`alter table t2 add constraint u2 unique (v)` behaves identically (both pending rows
already collide, and the statement is still accepted).

## Two independent defects

**1. The build/validate scan reads the base layer only.**
`BaseLayer.populateNewIndex` walks `this.primaryTree` — the committed rows. The DDL
connection's `pendingTransactionLayer` holds its uncommitted writes, so an in-transaction
row never enters the duplicate check and never enters the new index.

`MemoryTableManager.ensureSchemaChangeSafety` looks like it drains this, but it only
consolidates *committed* transaction layers into the base and re-points read-only
connections. A connection's own uncommitted `pendingTransactionLayer` is untouched.

**2. After the DDL, the open transaction stops enforcing the new constraint.**
`TransactionLayer` freezes its schema at construction (`tableSchemaAtCreation`) and builds
its `secondaryIndexes` map from that snapshot's `schema.indexes`. A layer created before the
`create index` therefore has neither the new `IndexSchema` nor the derived
`uniqueConstraints` entry. `checkUniqueConstraints` iterates `schema.uniqueConstraints` and
`findIndexForConstraint` resolves through `targetLayer.getSecondaryIndex(...)` — both come up
empty, so the second insert is not checked against anything. This is why the duplicate insert
above is accepted even though the base index exists.

The commit-time `consolidateToBaseLayer` → `rebuildPrimaryTreeFromRows` →
`rebuildAllSecondaryIndexes` uses the **non-strict** rebuild, which logs-and-drops duplicate
index keys rather than raising. So the duplicate reaches the committed base silently.

## Expected behavior

Row-validating DDL sees exactly the rows a `select` in the same transaction would see, and
the constraint it declares is enforced for the remainder of that transaction:

- `create unique index` / `add constraint … unique` raise `UNIQUE constraint failed` when the
  transaction's own uncommitted rows already violate the constraint.
- When they do not, the statement succeeds and a *later* colliding insert in the same
  transaction is rejected.
- `rollback` discards the pending rows; the committed base index is left holding exactly the
  committed rows. (The catalog entry for the index survives the rollback — see
  "Transaction semantics of DDL" below. That is existing, intentional-by-default behavior and
  is not in scope here.)

## Shape of the fix

Keep the invariant **"the base layer's structures contain exactly the committed rows."** Do
not write pending rows into the base index; that would expose one connection's uncommitted
rows to another's index scans.

Instead, split what `addIndexToBase` does today into three steps, driven from
`MemoryTableManager.createIndex` and `MemoryTableManager.addUniqueConstraint`:

1. **Validate over the effective row set.** Walk the DDL connection's view — the base primary
   tree overlaid with its `pendingTransactionLayer`'s modification tree, which is exactly what
   `TransactionLayer.getModificationTree('primary')` already yields (the pending BTree is
   copy-on-write over the base's). Run the same duplicate detection `populateNewIndex` runs
   today (partial-predicate skip, multiple-NULLs-allowed, collation-aware via the index's own
   `compareKeys`), and throw `CONSTRAINT` before mutating anything. When the connection has no
   pending layer this degenerates to the current base-only scan.

2. **Populate the base index from base rows only** — `populateNewIndex` unchanged, minus the
   duplicate check it no longer needs to own (or keep it: over a subset of an already-validated
   set it can never fire; a comment saying so is cheaper than a second code path).

3. **Refresh the pending layer(s)** so the rest of the transaction enforces the new
   constraint. Rather than rebasing (which would invalidate the savepoint snapshots held in
   `MemoryTableConnection.savepointStack`), add a `TransactionLayer.adoptSchema(newSchema)`
   that:
   - replaces `tableSchemaAtCreation` with `newSchema` (only additive index/constraint DDL
     reaches this path, so `pkFunctions` and the primary tree stay valid);
   - for each `IndexSchema` in `newSchema.indexes` with no entry in `secondaryIndexes`,
     constructs a `MemoryIndex` over the parent's (now-populated) secondary tree — the same
     construction `initializeSecondaryIndexes` performs — and then inserts this layer's own
     effective rows that are not already present in the inherited base tree, i.e. the rows in
     its own modification tree.

   Apply `adoptSchema` to the DDL connection's pending layer **and** to every
   `TransactionLayer` in its savepoint snapshot chain, so a `rollback to savepoint` does not
   restore a stale-schema layer.

**Other connections' pending layers.** A sibling connection holding its own uncommitted writes
cannot be validated against (its rows are invisible to the DDL's transaction) and would be left
with a stale schema. Raise `BUSY` from `ensureSchemaChangeSafety` — the same posture, and
nearly the same message, as the existing "older transaction versions are in use" branch. Only
the DDL-issuing connection may hold a pending layer.

To identify the DDL-issuing connection: `MemoryTableManager` already reaches the Database's
connection registry in `repointRegisteredConnections` via
`this.db.getConnectionsForTable(`${schemaName}.${tableName}`)` and narrows to
`MemoryVirtualTableConnection` → `getMemoryConnection()`. Reuse that walk. The manager's `db`
is the owning `Database`, so any connection it returns is by definition this statement's
transaction.

## Transaction semantics of DDL — record the decision, do not widen the fix

Today the catalog entry (`SchemaManager`) and the base index BTree are written immediately,
outside the transaction coordinator, so `rollback` does not undo a `create index`. Nate's
guidance: Quereus should *support* the cleanest semantics for modules that fully cooperate,
and document/expose the limits where a module is degraded.

This ticket does **not** make DDL roll back. It makes DDL's row validation and its
in-transaction enforcement correct, which is the part that can silently corrupt data. The
leftover-index-after-rollback case remains benign: every reader re-validates an index entry
against the live row before returning it, so a stale entry can never manufacture a result.

Write that up — the boundary, why it is safe, and what a fully-cooperating module would do
instead — as a short section in `docs/memory-table.md` (and a cross-reference from
`docs/module-authoring.md` if one fits naturally). The capability-flag question is a separate
ticket (`feat-ddl-transaction-capability` in `tickets/backlog/`); do not add a flag here.

## TODO

Phase 1 — validation sees pending rows

- Add a manager-private helper that resolves the DDL-issuing `MemoryTableConnection` (reusing
  the `db.getConnectionsForTable` walk from `repointRegisteredConnections`) and returns its
  effective primary-row iterable: the pending layer's modification tree when one exists, else
  the base primary tree.
- In `ensureSchemaChangeSafety`, raise `BUSY` when a connection *other than* the DDL issuer
  holds a `pendingTransactionLayer`.
- Extract the duplicate-detection body of `BaseLayer.populateNewIndex` into a function that
  takes a row iterable and an `IndexSchema` (plus the `MemoryIndex` used as the
  collation-aware key comparator), and call it from `createIndex` / `addUniqueConstraint` over
  the effective rows *before* `addIndexToBase` mutates anything. A throw must leave the schema
  and the index map untouched — the existing catch in `createIndex` / `addConstraint` restores
  `originalManagerSchema`; verify it also drops the half-built `MemoryIndex`.

Phase 2 — enforcement for the rest of the transaction

- Add `TransactionLayer.adoptSchema(newSchema: TableSchema): void` per the design above,
  covering both the new-index and the derived-`uniqueConstraints` cases.
- Call it from `createIndex` and `addUniqueConstraint` after the base index is populated, for
  the DDL connection's pending layer and every `TransactionLayer` in its savepoint chain.
  `MemoryTableConnection.savepointStack` is private — add a narrow accessor rather than
  loosening the field.
- Confirm the `add constraint … unique` reuse path (an existing collation-equivalent unique
  index already covers the columns) also lands the new `uniqueConstraints` entry in the pending
  layer's schema — it takes an early return that skips `addIndexToBase`.

Phase 3 — tests and docs

- `packages/quereus/test/` mocha spec: the two reproductions above; the non-colliding
  counterpart (DDL accepted, later colliding insert in the same transaction rejected); a
  `rollback` case asserting the committed table is unchanged and a fresh insert of the
  previously-pending value is accepted; a savepoint case (`savepoint s; insert dup; create
  unique index` ⇒ rejected) ; a second-connection case asserting `BUSY`.
- Shared sqllogic in `test/logic/10.1-ddl-lifecycle.sqllogic` (or a new `10.2-ddl-in-transaction.sqllogic`)
  covering `create unique index` and `add constraint … unique` against pending rows. This file
  runs against both backends, so land it only after
  `bug-store-add-constraint-unique-ignores-pending-rows`.
- Document the DDL transaction boundary in `docs/memory-table.md` as described above.
- Run `yarn test`, `yarn workspace @quereus/quereus test:store`, `yarn lint`.
