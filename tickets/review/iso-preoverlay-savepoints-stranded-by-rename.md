---
description: Fixed a bug where renaming a table inside a transaction left stale savepoint bookkeeping behind, which could make a later "roll back to savepoint" in the *next* transaction silently throw away rows it should have kept.
prereq:
files: packages/quereus-isolation/src/isolation-module.ts (renameTable ~1092-1106), packages/quereus-isolation/src/isolated-table.ts (savepointsBeforeOverlay getter ~66-82), packages/quereus-isolation/test/isolation-layer.spec.ts (describe('savepoints'), two new tests at end of block)
difficulty: medium
---

# Don't re-key the pre-overlay savepoint set on rename

## What changed

Three edits, no behavior added — one deletion plus documentation plus regression tests.

1. **`IsolationModule.renameTable()`** — deleted
   `this.rekeyConnectionScopedMap(this.preOverlaySavepoints, schemaName, oldName, newName)`
   and the `NOTE:` block that pointed at this ticket slug. Replaced with a comment
   explaining why leaving the set under the old name is correct. `connectionOverlays`
   still re-keys (the commit flush resolves an overlay's underlying by *current* name);
   `rekeyConnectionScopedMap` therefore still has exactly one caller.

2. **`IsolatedTable.savepointsBeforeOverlay` getter** — added a `NOTE:` recording that the
   set is keyed by the name the `IsolatedTable` was *constructed* with, which after a
   mid-transaction rename is the pre-rename name, and that this is deliberate: the same
   instance clears the set at commit/rollback, so the key must not move out from under it.

3. **Two regression tests** appended to `describe('savepoints')` in
   `packages/quereus-isolation/test/isolation-layer.spec.ts`, plus a small
   `preOverlaySavepointEntries()` helper that reaches the private map the same way the
   existing `preOverlaySavepointKeys()` helper (line ~1269) does — an `as unknown as`
   cast, not a new `@internal` accessor, matching the file's prevailing style.

## Why the deletion is the fix

The set `IsolationModule.preOverlaySavepoints` records savepoint depths taken before a
transaction's overlay table existed. Its maintainers — `onConnectionSavepoint`,
`onConnectionReleaseSavepoint`, `onConnectionRollbackToSavepoint`, `onConnectionCommit`,
`onConnectionRollback` — all live on the `IsolatedTable` that the registered
`IsolatedConnection` was built from, and that instance keeps the pre-rename name for the
rest of the transaction. So re-keying old→new moved the set out from under every callback
that touches it: the commit path cleared an old-name key that was now empty, and the
moved new-name set leaked into the next transaction.

Nothing needs carrying across. The first statement after the rename connects a fresh
`IsolatedTable` under the new name; its `ensureConnection()` registers a new
`IsolatedConnection`, and `Database.registerConnection` (`packages/quereus/src/core/database.ts:1849-1862`)
replays the live savepoint stack onto it, driving `onConnectionSavepoint(depth)` for each
active depth and rebuilding the set under the new name from scratch.

## Use cases / validation

**Both new tests fail before the deletion and pass after.** Verify by re-adding the
`rekeyConnectionScopedMap(this.preOverlaySavepoints, …)` line.

- *`a mid-transaction RENAME TO leaves no pre-overlay savepoint depths behind after commit`* —
  `begin; savepoint s1; insert; alter table widget rename to gadget; commit`, then asserts
  every live `preOverlaySavepoints` entry holds an empty depth set. Pre-fix:
  `[["1:main.gadget", [0]]]`.
- *`a stale pre-overlay depth from a renaming transaction does not wipe the next transaction's overlay`* —
  the silent-wrong-answer case. Txn 1 leaks `{0, 1}` under `gadget`; txn 2 writes row 2
  *before* any savepoint, then takes two savepoints and rolls back to the inner one at
  depth 1. Pre-fix the stale depth-1 hit made `onConnectionRollbackToSavepoint(1)` conclude
  the savepoint pre-dated the overlay and call `clearOverlay()`, losing row 2. Asserts
  `[1, 2]`.

Why depth **1** and not depth 0: statement-level savepoints scrub whatever depth a
statement runs at, so a stale depth 0 gets cleaned up by accident. The test needs two
user savepoints in the renaming transaction to leak a depth that survives. A reviewer
tempted to "simplify" the test down to one savepoint will get a test that passes either
way — that is the trap.

**Commands run, both clean:**
- `yarn workspace @quereus/isolation run test` — 163 passing (was 161; +2 new).
- `yarn test` — full workspace, all green, ~3m9s. No pre-existing failures surfaced.

Not run: `yarn test:store` (ticket didn't ask; the isolation layer's savepoint bookkeeping
is above the storage module and the memory-backed path exercises it identically) and
`yarn lint` (only `packages/quereus` has a real lint; nothing in this diff touches it).
A reviewer who wants belt-and-braces can run either.

## Known gaps / what I did not do

- **The tests reach private state via `as unknown as`.** Consistent with the file, but it
  means the first regression test is coupled to the map's name and shape. If a reviewer
  prefers an `@internal` accessor on `IsolationModule`, that is a clean small change —
  I chose consistency with the surrounding 5 call sites over introducing a new pattern.

- **The first test asserts "no entry retains any depth", not "the map is empty."**
  `getPreOverlaySavepoints()` lazily inserts an empty `Set` on read, so empty-set entries
  are expected and harmless. Asserting `map.size === 0` would be wrong. Worth confirming
  I read that lazily-inserting getter right (`isolation-module.ts:369-376`).

- **I did not chase the underlying identity problem.** After a mid-transaction rename the
  old-name `IsolatedConnection` stays registered for the rest of the transaction (and, in
  the traces I took, into the next one), so its old-name `IsolatedTable` keeps receiving
  savepoint/commit callbacks. With this fix those callbacks are harmless: they maintain
  and then clear an old-name set, and their `clearOverlay()` targets an old-name key that
  no longer holds an overlay. The root fact — *a rename does not update the identity of
  the already-registered connection* — is tracked by
  `fix/iso-rename-in-txn-never-flushes-staged-rows`. Parked as a `NOTE:` on the
  `savepointsBeforeOverlay` getter rather than as a new ticket.

- **Not tested: rename inside a savepoint that is then rolled back**, and **two renames in
  one transaction**. Both look fine by inspection (each rename leaves the set where its
  maintainer expects it, and replay rebuilds under whatever the current name is), but I
  did not write them. If the reviewer wants more coverage, those are the two shapes I'd
  add next.

## Review findings

- Tripwire, parked as a `NOTE:` at `IsolatedTable.savepointsBeforeOverlay`
  (`packages/quereus-isolation/src/isolated-table.ts:66-82`): the pre-overlay savepoint set
  is keyed by the constructing table name, not the current catalog name. Deliberate and
  correct today; it only becomes work if the isolation layer ever starts re-identifying an
  already-registered connection on rename.
