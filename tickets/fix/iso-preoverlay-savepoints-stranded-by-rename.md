---
description: After a table is renamed inside a transaction, some bookkeeping about that transaction's savepoints is left behind instead of being cleaned up, and the next transaction on the renamed table reads the stale leftovers — which can make a later "roll back to savepoint" throw away writes it should have kept.
prereq:
files: packages/quereus-isolation/src/isolation-module.ts (renameTable ~1010, preOverlaySavepoints), packages/quereus-isolation/src/isolated-table.ts (savepointsBeforeOverlay ~73, onConnectionCommit ~1448, onConnectionRollback ~1466, ensureOverlay ~204), packages/quereus-isolation/test/isolation-layer.spec.ts
difficulty: medium
---

# A mid-transaction rename strands the pre-overlay savepoint set

## Background

The isolation layer stages a transaction's uncommitted writes in a per-connection **overlay**
table, created lazily on the first write. If savepoints were taken *before* the overlay
existed, the overlay's own savepoint stack has to be padded so that a later "roll back to
savepoint N" indexes the right entry. Those pre-overlay savepoint depths are recorded in
`IsolationModule.preOverlaySavepoints`, keyed `"<dbId>:<schema>.<table>"` — the same key shape
as the overlays themselves.

At the end of a transaction, each table's set is cleared by its own connection:
`IsolatedTable.onConnectionCommit()` / `onConnectionRollback()` call
`clearPreOverlaySavepoints(this.db, this.schemaName, this.tableName)`.

## Defect

`IsolationModule.renameTable()` re-keys `preOverlaySavepoints` from the old name to the new
one, alongside the overlay. But the object that clears the set at end-of-transaction is the
`IsolatedTable` that the registered connection was built from — and that instance was
constructed under the **old** name and keeps it. So the clear targets
`<dbId>:<schema>.<oldName>` (now absent) while the re-keyed `<dbId>:<schema>.<newName>` set
survives the transaction.

Confirmed by probe against the in-memory storage module, after the fixes in
`tickets/complete/2-iso-orphaned-overlay-drop-rename.md`:

```ts
await db.exec(`create table widget (id integer primary key, name text) using isolated`);
await db.exec(`begin`);
await db.exec(`savepoint s1`);                    // taken before the overlay exists
await db.exec(`insert into widget values (1, 'a')`);
await db.exec(`alter table widget rename to gadget`);
await db.exec(`commit`);

// preOverlaySavepoints after commit: [["114:main.gadget", [0]]]
```

The entry should be empty. It contains depth `0`, left over from a transaction that has ended.

## Why it matters

The next transaction that writes to `gadget` re-reads that stale set, and it is consulted in
two places:

- `IsolatedTable.ensureOverlay()` pre-aligns the overlay's connection (registering an extra
  connection to replay a savepoint stack) whenever the set is non-empty — here, spuriously.
- `IsolatedTable.onConnectionRollbackToSavepoint(index)` treats a hit in the set as "this
  savepoint pre-dates the overlay" and **discards the entire overlay**. With a stale depth `0`
  in the set, a later `rollback to savepoint` at that depth throws away staged writes made
  *before* the savepoint, which the user asked to keep.

The second is a silent-wrong-answer bug, not just a leak. It needs a written reproduction
through SQL before the fix is designed — the probe above establishes the stale state, not yet
the user-visible mis-rollback.

## The deeper question

Re-keying `preOverlaySavepoints` on rename may be the wrong move altogether. The registered
connection's callback object keeps the old name for the whole transaction, so **every**
savepoint callback after the rename (`onConnectionSavepoint`, `onConnectionReleaseSavepoint`,
`onConnectionRollbackToSavepoint`) also lands on the old-name set. Re-keying moves the set out
from under the very callbacks that maintain it. Two coherent designs:

- **Don't re-key.** Leave the set under the old name for the life of the transaction, matching
  where the callbacks write, and let it be cleared normally at commit/rollback. The overlay
  itself still must be re-keyed (the commit flush resolves it by current name).
- **Re-key everything, including identity.** Give the live `IsolatedTable` / `IsolatedConnection`
  the new name on rename. Bigger change, and it interacts with
  `fix/iso-rename-in-txn-never-flushes-staged-rows`, where the store module evicts that
  connection entirely.

These two tickets are looking at the same underlying fact — *a rename does not update the
identity of the already-registered connection* — from different maps. Worth reading together.

## Expected behavior

- After any transaction ends (commit or rollback), no `preOverlaySavepoints` entry survives for
  a table that transaction touched, whether or not it was renamed mid-transaction.
- `begin; savepoint s1; insert; alter table t rename to t2; commit;` followed by a second
  transaction on `t2` that takes a savepoint and rolls back to it must keep the writes made
  before that savepoint.

## Notes

Where the leak is created is marked in `isolation-module.ts` with a `NOTE:` comment pointing at
this ticket slug. Regression coverage belongs in
`packages/quereus-isolation/test/isolation-layer.spec.ts`; the existing `savepoints` describe
block has the scaffolding.
