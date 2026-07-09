---
description: Fixed a bug where renaming a table inside a transaction left stale savepoint bookkeeping behind, which could make a later "roll back to savepoint" in the next transaction silently throw away rows it should have kept.
prereq:
files: packages/quereus-isolation/src/isolation-module.ts (renameTable ~1092-1111), packages/quereus-isolation/src/isolated-table.ts (savepointsBeforeOverlay getter ~66-82), packages/quereus-isolation/test/isolation-layer.spec.ts (describe('savepoints'), four tests at end of block), docs/design-isolation-layer.md (renameTable bullet ~159)
difficulty: medium
---

# Don't re-key the pre-overlay savepoint set on rename

## What shipped

`IsolationModule.renameTable()` no longer re-keys `preOverlaySavepoints` from the old table
name to the new one. `connectionOverlays` still re-keys — the commit flush resolves an
overlay's underlying table by its *current* name, so that map has to move.

The savepoint depth set must not. Its maintainers (`onConnectionSavepoint`,
`onConnectionReleaseSavepoint`, `onConnectionRollbackToSavepoint`, `onConnectionCommit`,
`onConnectionRollback`) all live on the `IsolatedTable` that the registered
`IsolatedConnection` was built from, and that instance keeps the pre-rename name for the
rest of the transaction. Re-keying moved the set out from under every one of them: the
commit path cleared a now-empty old-name key, and the moved new-name set survived into
the *next* transaction — where a `rollback to savepoint` at a matching depth concluded
the savepoint pre-dated the overlay and discarded the whole overlay, losing rows the
statement should have kept.

Nothing needs carrying across the rename. The first statement after it connects a fresh
`IsolatedTable` under the new name, whose `ensureConnection()` registers a new
`IsolatedConnection`; `Database.registerConnection` then replays the live savepoint stack
onto it.

Also shipped: a `NOTE:` on the `savepointsBeforeOverlay` getter recording that the set is
keyed by the constructing table name, and four regression tests in
`describe('savepoints')`.

## Review findings

### Verified the fix is load-bearing (not a no-op cleanup)

Re-added `rekeyConnectionScopedMap(this.preOverlaySavepoints, …)` as a temporary probe and
re-ran the suite. Both implement-stage tests fail with the line present and pass with it
absent — the first with `stranded savepoint depths under 48:main.gadget: expected [ +0 ] to
deeply equal []`, the second losing row 2 (`expected [ 1 ] to deeply equal [ 1, 2 ]`). Probe
reverted. The tests genuinely guard the deletion.

Also confirmed the implement handoff's warning: the second test needs *two* user savepoints
in the renaming transaction. Statement-level savepoints scrub depth 0, so a one-savepoint
version of that test would pass with or without the fix.

### Correctness (checked, one doc-level defect found and fixed)

Traced every path the deletion touches. The fix is sound, but two of its own comments
overclaimed: both said the post-rename connection's savepoint replay "rebuilds the set under
the new name from scratch." That is true only when **no** overlay was carried across the
rename. When one was, `onConnectionSavepoint` short-circuits on `if (!this.overlayTable)` and
adds nothing — the set stays empty, and savepoint restore is instead owned by the overlay's
own registered memory connection, which `ensureOverlay()` pre-registers precisely so
`Database.registerConnection` gives it a snapshot per active depth. Behavior is correct in
both cases; the comments described only one. Corrected in `isolation-module.ts:1104-1111` and
`isolated-table.ts:73-79`.

### Test coverage (gap found, closed inline)

The implement handoff named two untested shapes and declined to write them. Both were cheap
and both are exactly the shapes the deletion could have broken, so I added them:

- `a savepoint taken before the overlay still discards it after a RENAME TO` — the direct
  proof that nothing needs carrying across: `savepoint s1; rename; insert; rollback to s1`
  discards the staged row. This is the test that would have caught the deletion if the
  "rebuilds from scratch" claim had been the *only* mechanism.
- `two RENAME TO in one transaction strand no pre-overlay savepoint depths` — the
  intermediate name gets its own `IsolatedTable` and its own set; both are cleared at
  commit, and both rows survive.

Isolation suite: 163 → 165 passing.

### Docs (found stale, fixed)

`docs/design-isolation-layer.md:159-165` documents each table-lifecycle hook's obligations
toward the connection-scoped maps, and its `renameTable()` bullet described only the overlay
re-key and the underlying re-connect. It was not *wrong*, but a reader adding a third
connection-scoped map would have found no statement of why one map moves and the other
deliberately does not — exactly the trap this ticket was filed for. Added that paragraph.
No other doc mentions `preOverlaySavepoints`.

### Non-findings, stated explicitly

- **`rollback to savepoint` does not undo the rename.** Observed while writing the
  pre-overlay-savepoint test: after `savepoint s1; alter table widget rename to gadget;
  rollback to savepoint s1`, the table is still `gadget`. Chased it before assuming a bug —
  Quereus DDL is non-transactional by design (`docs/sqlite-test-crosscheck.md:182-183`,
  `docs/design-isolation-layer.md:650`), and `schema/` has no savepoint awareness at all.
  Not a defect. Recorded as a comment in the test so the next reader doesn't re-chase it.
- **Test-only access to private state via `as unknown as`.** The handoff flagged this as a
  possible objection. It matches five existing call sites in the same spec file; introducing
  an `@internal` accessor for one new helper would be the inconsistent choice. Left as is.
- **`getPreOverlaySavepoints()` lazily inserts an empty `Set` on read,** so the first test's
  "every entry holds an empty depth set" is the right assertion and `map.size === 0` would be
  wrong. Confirmed at `isolation-module.ts:369-376`. The handoff read it correctly.
- **No new tickets filed.** Nothing found rose to major. The one architectural concern
  (below) is conditional, so it is a tripwire, not a ticket.

### Tripwire

Parked as a `NOTE:` at `IsolatedTable.savepointsBeforeOverlay`
(`packages/quereus-isolation/src/isolated-table.ts:66-82`): the pre-overlay savepoint set is
keyed by the constructing table name, not the current catalog name. Correct today, because
after a mid-transaction rename the old-name `IsolatedTable` stays the registered connection's
callback object and its now-inert `clearOverlay()` targets a key that holds no overlay. It
only becomes work if the isolation layer ever starts re-identifying an already-registered
connection on rename — the root fact tracked by
`fix/iso-rename-in-txn-never-flushes-staged-rows`. At that point the set's key must move with
the connection's identity, and this deletion has to be revisited alongside it.

## Validation

- `yarn workspace @quereus/isolation run test` — 165 passing.
- `yarn test` (full workspace) — all green, ~3m. No pre-existing failures surfaced.
- `yarn lint` — clean (31s; only `packages/quereus` has a real lint and this diff does not
  touch it).
- Not run: `yarn test:store`. The savepoint bookkeeping under review lives above the storage
  module and the memory-backed path drives the same callbacks; the store path adds no
  distinct behavior here.
