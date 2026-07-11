---
description: Every transaction that wrote to a table left behind a small in-memory staging table that was never freed, slowly growing a long-lived connection's memory without bound — now fixed with a single release path and a regression test that pins the table count back to baseline after every transaction.
files:
  - packages/quereus-isolation/src/isolation-module.ts        # releaseOverlayTable helper; release at commit/destroy/adopt/rebuild/closeAll; clearConnectionOverlay now async; ConnectionOverlayState gained `db`
  - packages/quereus-isolation/src/isolated-table.ts          # ensureOverlay sets state.db; clearOverlay async; awaits threaded through rollback/alterSchema/onConnectionRollback/onConnectionRollbackToSavepoint
  - packages/quereus-isolation/src/isolated-connection.ts     # (unchanged) commit() calls overlayConnection.commit() AFTER the release — teardown-ordering context for the reviewer
  - packages/quereus/src/vtab/memory/module.ts                # (unchanged) MemoryTableModule.destroy — the sink; public `tables` map the test asserts on
  - packages/quereus/src/vtab/memory/layer/manager.ts         # (unchanged) MemoryTableManager.destroy / disconnect — tolerance relied on
  - packages/quereus-isolation/test/isolation-layer.spec.ts   # two new describes at EOF: 9 baseline-count regression tests
difficulty: medium
---

# Release isolation overlay tables instead of leaking them — READY FOR REVIEW

## What was wrong (confirmed root cause)

The isolation layer stages each connection's uncommitted writes in a private in-memory
*overlay* table (`_overlay_<table>_<id>`), created via `overlayModule.create()` (default a
`MemoryTableModule`). `MemoryTableModule.create()` registers the overlay's manager in the
module's public `tables` map; the ONLY thing that removes an entry is
`MemoryTableModule.destroy()`. The isolation layer never called it — every discard path just
dropped the reference (`connectionOverlays.delete`), leaving the overlay's manager and its
staged rows reachable from `overlayModule.tables` for the life of the `Database`. One dead
in-memory table per (connection, table) overlay — roughly one per writing transaction, plus
one per overlay rebuild. Unbounded.

## The fix

A single sink — `IsolationModule.releaseOverlayTable(state)` — calls
`overlayModule.destroy(state.db, undefined, overlaySchema.vtabModuleName, schemaName, name)`
to free the staging table. Every abandon path now funnels through it:

- **commit** — `commitConnectionOverlays` releases each applied `entries[i]` and each
  `orphanedCleanKeys` overlay at its delete.
- **rollback / alterSchema / rollback-to-pre-overlay-savepoint** — all route through
  `clearConnectionOverlay`, now `async` (release-then-delete). `await` threaded up through
  `clearOverlay`, `rollback`, `onConnectionRollback`, `onConnectionRollbackToSavepoint`,
  `alterSchema`.
- **DROP TABLE** — `destroy` releases on its delete branch (own overlay + foreign clean);
  a *surviving poisoned* foreign overlay is intentionally NOT released (freed later when its
  owner rolls back).
- **rebuild replace** — `adoptRebuiltOverlay` releases the OLD overlay only after the new one
  is installed (never on the poison/throw path, where the old overlay stays live).
- **rebuild failure** — each builder (`rebuildOverlayForIndexChange`,
  `migrateOverlayForAlter`) wraps its row-copy loop and frees the half-built NEW overlay on
  throw, then rethrows.
- **closeAll** — releases every overlay before clearing the maps.

## Design decision the reviewer should weigh: `db` stored on state, not passed in

The ticket proposed `releaseOverlayTable(db, state)` with `db` passed at each call site,
asserting "db is in scope at every release site." **That is false for `closeAll()`** (no
ambient db) and **wrong for `destroy()` / `closeAll()`**, which sweep overlays across
MULTIPLE db ids — the ambient/sweeper db is not the overlay's own db. For the default
`MemoryTableModule` this is harmless (its `destroy` identifies the table by schema+name and
ignores `db`), but a host-injected `config.overlay` keyed per-db would be handed the wrong
db.

So instead: `ConnectionOverlayState` gained a required `db: Database` field, set at the three
real creation sites (`ensureOverlay` + the two rebuild builders). `releaseOverlayTable(state)`
uses `state.db`. This is correct for multi-db sweeps and makes `closeAll` trivial. The field
is **required**, so the package's `tsc` build fails fast if a future creation site forgets it
(no silent-leak footgun) — verified `yarn workspace @quereus/isolation run build` is green.

Cost: the interface change touched 9 test overlay-construction sites (all had a db var in
scope; each now passes `db`). No production code outside the isolation package references
`ConnectionOverlayState` or `clearConnectionOverlay` (grep-verified), so the async signature
change has no external blast radius.

## Integration risk — verified, not just asserted

`IsolatedConnection.commit()` calls `overlayConnection.commit()` AFTER
`commitConnectionOverlays` has already destroyed the overlay's manager; rollback is
analogous. And when a savepoint pre-dates the overlay, `ensureOverlay` registers the
overlay's OWN `MemoryVirtualTableConnection` directly with the `Database`, so the db later
tears down a connection whose manager is gone. `MemoryTableManager.disconnect` tolerates a
detached connection (`!connection → no-op`) and `MemoryTableManager.destroy` rolls back the
overlay's pending layer, so this does not throw. **Confirmed by tests**, not reasoning alone:
the two `pre-overlay savepoint + commit` / `+ rollback` cases pass, and the pre-existing
savepoint suite (spec ~931, ~955) — which exercises the same registered-overlay-connection
teardown on rollback — stays green.

## `preOverlaySavepoints` — the ticket's secondary question (answered: not a leak)

Same map shape, but holds only `Set<number>` (savepoint depths), and IS reliably cleared at
transaction end (`onConnectionCommit`/`onConnectionRollback` → `clearPreOverlaySavepoints`;
`destroy` sweeps it). Not a row-holding leak. Left as-is; the new release paths keep its
existing cleanup intact.

## How to validate

- `yarn workspace @quereus/isolation test` — **240 passing** (9 new). Was 231 before.
- `yarn build` — green (compiles all packages).
- `yarn lint` — green.

The regression tests (two `describe`s at the end of `isolation-layer.spec.ts`) assert the
class-of-bug invariant directly: **`overlayModule.tables.size` returns to its baseline of 0
after every cycle.** `overlayModule` is a public field and `MemoryTableModule.tables` a public
`Map`, so the count is read directly. Cycles covered:

- write + commit
- write + rollback
- write + create index (rebuild) + commit
- write + drop index (rebuild) + commit
- write + alter table add column + commit
- write + drop table
- pre-overlay savepoint + commit (teardown ordering)
- pre-overlay savepoint + rollback (teardown ordering)
- rebuild-FAILURE: a foreign connection stages duplicate rows, another issues
  `create unique index` → the half-built rebuild overlay is freed AND the poisoned old
  overlay is freed when the foreign connection rolls back (asserts count is 1, not 2, after
  the failed rebuild, then 0 after rollback).

## Known gaps / notes for the reviewer (treat tests as a floor)

- **Framework mismatch in the ticket.** The ticket said the spec is Vitest; it is actually
  **Mocha + chai** (`packages/quereus-isolation/test`, run via ts-node `transpileOnly`). I
  followed the existing framework. Also the workspace is `@quereus/isolation` (not
  `@quereus/quereus-isolation` as the ticket's TODO wrote).
- **Test type-checking blind spot.** This package's `lint` is a no-op and its `tsconfig`
  excludes `test/`, and ts-node runs `transpileOnly` — so the spec's types are NOT checked by
  any CI gate. I updated all 9 overlay-construction sites to satisfy the new required `db`
  field, but a reviewer relying on `yarn lint` to catch spec type drift should know it won't.
- **`closeAll` release is exercised only indirectly.** No direct `closeAll` unit test asserts
  the count; its release loop is simple and mirrors the others. If the reviewer wants belt-
  and-suspenders, a `closeAll`-with-open-overlays count assertion would close that.
- **Rebuild-failure test uses direct overlay injection** (`setConnectionOverlay`) for the
  foreign connection and a direct `clearConnectionOverlay` call to stand in for its rollback —
  matching the established white-box pattern in the two-db suites — rather than a fully
  SQL-driven second transaction. The SQL end-to-end paths ARE covered by the first eight
  cycles.
- **Pre-existing, unrelated:** LSP flags unused-locals at `isolated-table.ts` (`_exhaustive`
  ~575, `tombstoneIndex` ~1303/1413). Not touched by this change; `noUnusedLocals` is off in
  the build config so they are non-fatal. Not this ticket's concern.
