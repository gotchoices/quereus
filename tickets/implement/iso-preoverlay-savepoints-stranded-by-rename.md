---
description: After a table is renamed inside a transaction, leftover bookkeeping about that transaction's savepoints survives into the next transaction, where a later "roll back to savepoint" can throw away writes it was supposed to keep. Stop moving that bookkeeping when a table is renamed.
prereq:
files: packages/quereus-isolation/src/isolation-module.ts (renameTable ~1070-1106, preOverlaySavepoints ~137, destroy ~773), packages/quereus-isolation/src/isolated-table.ts (savepointsBeforeOverlay ~73, ensureOverlay ~204, onConnectionCommit ~1448, onConnectionRollbackToSavepoint ~1505), packages/quereus-isolation/test/isolation-layer.spec.ts (describe('savepoints') ~770), packages/quereus/src/core/database.ts (registerConnection ~1833, savepoint replay ~1849)
difficulty: medium
---

# Don't re-key the pre-overlay savepoint set on rename

## Background

The isolation layer stages a transaction's uncommitted writes in a per-connection
**overlay** table, created lazily on the first write. Savepoints taken *before* the
overlay existed are recorded in `IsolationModule.preOverlaySavepoints`, keyed
`"<dbId>:<schema>.<table>"`. Two consumers read the set:

- `IsolatedTable.ensureOverlay()` — if the set is non-empty, pre-registers the overlay's
  connection so `Database.registerConnection` replays the savepoint stack onto it.
- `IsolatedTable.onConnectionRollbackToSavepoint(index)` — a hit means "this savepoint
  pre-dates the overlay", so the whole overlay is discarded.

The set is cleared at end-of-transaction by `IsolatedTable.onConnectionCommit()` /
`onConnectionRollback()`, which call
`clearPreOverlaySavepoints(this.db, this.schemaName, this.tableName)` — using the names the
`IsolatedTable` was *constructed* with.

## Root cause (confirmed)

`IsolationModule.renameTable()` re-keys `preOverlaySavepoints` old→new
(`isolation-module.ts:1101`). But the object that clears the set is the `IsolatedTable`
the registered `IsolatedConnection` was built from, and that instance keeps the **old**
name for the life of the transaction. So the clear targets
`<dbId>:<schema>.<oldName>` (now absent) and the re-keyed `<newName>` set survives the
transaction and is read by the next one.

The re-key is not merely useless, it is actively wrong: the callbacks that *maintain* the
set (`onConnectionSavepoint` / `onConnectionReleaseSavepoint` /
`onConnectionRollbackToSavepoint`) all still resolve the old name, so re-keying moves the
set out from under its own maintainers.

**Doing nothing is correct.** When a statement after the rename connects a fresh
`IsolatedTable` under the new name, its `ensureConnection()` registers a new
`IsolatedConnection`, and `Database.registerConnection` (`database.ts:1849-1862`) replays
the active savepoint stack onto it — which drives `onConnectionSavepoint(depth)` for every
live depth and rebuilds the set under the *new* name from scratch. Nothing needs to be
carried across. The old-name set stays where its own callbacks maintain it and is cleared
normally at commit/rollback. (The overlay itself must still be re-keyed — the commit flush
resolves it by current name — so leave that call alone.)

## Reproductions

Both were run against the in-memory storage module and both pass once the re-key is removed.

**1 — the leak.**

```ts
await db.exec(`create table widget (id integer primary key, name text) using isolated`);
await db.exec('begin');
await db.exec('savepoint s1');
await db.exec(`insert into widget values (1, 'a')`);
await db.exec('alter table widget rename to gadget');
await db.exec('commit');
// preOverlaySavepoints after commit: [["1:main.gadget", [0]]]   ← should be empty
```

**2 — the silent wrong answer.** The stale depth has to survive into a `rollback to
savepoint` at that exact depth. Statement-level savepoints scrub any depth a statement
runs at, so a stale depth `0` is usually cleaned up by accident; a stale depth `1` (two
user savepoints in the renaming transaction) is not. Then:

```ts
// txn 1 — leaks {0, 1} under `gadget`
await db.exec('begin');
await db.exec('savepoint a');
await db.exec('savepoint b');
await db.exec(`insert into widget values (1, 'a')`);
await db.exec('alter table widget rename to gadget');
await db.exec('commit');

// txn 2 — row 2 is written before any savepoint, so it must survive
await db.exec('begin');
await db.exec(`insert into gadget values (2, 'b')`);
await db.exec('savepoint s1');
await db.exec('savepoint s2');             // depth 1 — matches the stale entry
await db.exec(`insert into gadget values (3, 'c')`);
await db.exec('rollback to savepoint s2'); // stale hit → discards the WHOLE overlay
await db.exec('commit');

// select id from gadget  →  [1]      (actual, wrong)
//                        →  [1, 2]   (expected)
```

Row `2` is lost: `onConnectionRollbackToSavepoint(1)` sees the stale `1`, concludes the
savepoint pre-dates the overlay, and calls `clearOverlay()`.

## Change

Delete the `rekeyConnectionScopedMap(this.preOverlaySavepoints, ...)` call in
`renameTable()` (and the `NOTE:` comment above it that points at this ticket slug).
Replace with a short comment explaining why the set stays under the old name — the
registered connection's callback object keeps the old name, and a post-rename connection
rebuilds its own set through `registerConnection`'s savepoint replay.

Everything else stays: `connectionOverlays` still re-keys, `destroy()` still sweeps
`preOverlaySavepoints` across all db ids, `rekeyConnectionScopedMap` still has a caller.

Validated: with the call removed, all 161 tests in `@quereus/isolation` pass, plus both
reproductions above.

## Tripwire noticed while reproducing

After a mid-transaction rename, the old-name `IsolatedConnection` stays registered for the
rest of the transaction *and* (in these traces) into the next one, so its old-name
`IsolatedTable` keeps receiving savepoint/commit callbacks. With this fix those callbacks
are harmless — they maintain and then clear an old-name set, and their `clearOverlay()`
targets an old-name key that no longer holds an overlay. This is the same underlying fact
(`a rename does not update the identity of the already-registered connection`) tracked by
`fix/iso-rename-in-txn-never-flushes-staged-rows`; don't try to solve it here. Worth a
`NOTE:` at the `savepointsBeforeOverlay` getter recording that the set is keyed by the
constructing name, not the current catalog name.

## TODO

- Remove the `preOverlaySavepoints` re-key from `IsolationModule.renameTable()`; replace the
  `NOTE:` block with a comment stating why not re-keying is correct (savepoint replay in
  `Database.registerConnection` rebuilds the set under the new name).
- Add a `NOTE:` at `IsolatedTable.savepointsBeforeOverlay` that the set is keyed by the
  name this `IsolatedTable` was constructed with, which after a mid-transaction rename is
  the pre-rename name — and that this is deliberate, since the same instance clears it.
- Add regression tests to the existing `describe('savepoints')` block in
  `packages/quereus-isolation/test/isolation-layer.spec.ts`:
  - after `begin; savepoint s1; insert; alter table … rename to …; commit`, no
    `preOverlaySavepoints` entry retains any depth (reach the private map the way
    `isolation-layer.spec.ts` already reaches private state elsewhere, or add a small
    `@internal` accessor if that reads cleaner);
  - the two-transaction sequence in reproduction 2 above, asserting `[1, 2]`.
- Run `yarn workspace @quereus/isolation run test` and `yarn test`.
