---
description: Every transaction that writes to a table leaves behind a small in-memory staging table that is never freed, so a long-lived database connection slowly grows its memory use with no upper bound.
files:
  - packages/quereus-isolation/src/isolation-module.ts     # overlayModule.create sites; commitConnectionOverlays; destroy; adoptRebuiltOverlay; rebuild builders; clearConnectionOverlay; closeAll
  - packages/quereus-isolation/src/isolated-table.ts       # clearOverlay; rollback; alterSchema; onConnectionRollback; onConnectionRollbackToSavepoint
  - packages/quereus/src/vtab/memory/module.ts             # MemoryTableModule.destroy (removes tables-map entry); public tables map for the test assertion
  - packages/quereus-isolation/test/isolation-layer.spec.ts # add baseline-count regression test here
difficulty: medium
---

# Release isolation overlay tables instead of leaking them

## Root cause (confirmed)

The isolation layer stages each connection's uncommitted writes in a private in-memory
*overlay* table, built via `IsolationModule.overlayModule.create()` (default a
`MemoryTableModule`). `MemoryTableModule.create()` registers the new overlay's
`MemoryTableManager` in the module's public `tables` map (keyed by the overlay's unique name
`_overlay_<table>_<id>`), and the **only** thing that removes an entry is
`MemoryTableModule.destroy()` (`packages/quereus/src/vtab/memory/module.ts:891` — calls
`manager.destroy?.()` then `this.tables.delete(tableKey)`).

The isolation layer never calls that `destroy()`. Every place it stops referencing an overlay
just drops the reference (`connectionOverlays.delete(key)` / `clearConnectionOverlay`), leaving
the overlay's manager — and its staged rows — reachable from `overlayModule.tables` for the life
of the `Database`. Net: one dead in-memory table per (connection, table) overlay, i.e. roughly
one per writing transaction, plus one more per overlay rebuild. Unbounded.

## The overlay-create sites (3)

- `isolated-table.ts` `ensureOverlay()` — lazy create on first write.
- `isolation-module.ts` `rebuildOverlayForIndexChange()` — CREATE INDEX / DROP INDEX rebuild.
- `isolation-module.ts` `migrateOverlayForAlter()` — ALTER TABLE rebuild.

## Every site that abandons an overlay (each needs a release)

1. **Commit.** `commitConnectionOverlays()` deletes inline in two loops (the `entries` loop and
   the `orphanedCleanKeys` loop, ~lines 531-536). Both abandon `state.overlayTable`. Data is
   already flushed to the underlying in Phase 1/2 before these deletes, so the overlay is safe to
   destroy here.
2. **Rollback / alterSchema / rollback-to-pre-overlay-savepoint.** All route through
   `IsolatedTable.clearOverlay()` → `IsolationModule.clearConnectionOverlay()`. Callers:
   `rollback()` (isolated-table ~1569), `onConnectionRollback()` (~1697),
   `onConnectionRollbackToSavepoint()` (~1738), and `alterSchema()` (~1615, calls
   `clearConnectionOverlay` directly).
3. **DROP TABLE.** `IsolationModule.destroy()` deletes inline (~line 832) for the dropping
   connection's own overlay and for foreign clean overlays. A **surviving poisoned** foreign
   overlay is intentionally kept (not deleted) — it will be released later when its owning
   connection rolls back (path 2), so no extra handling is needed there, only in the delete branch.
4. **Rebuild replace.** `adoptRebuiltOverlay()` (~line 892) sets the new state over the old key.
   The **old** overlay (`oldState.overlayTable`) is abandoned after a successful rebuild.
5. **Rebuild failure.** When `insertIntoRebuiltOverlay()` throws mid-copy, the **half-built new**
   overlay created at the top of `rebuildOverlayForIndexChange()` / `migrateOverlayForAlter()` is
   abandoned. `adoptRebuiltOverlay`'s catch does not hold that handle, so the release must happen
   inside each builder (wrap the row-copy loop, destroy the new table, rethrow).
6. **closeAll.** Clears the three maps (~lines 936-938) but never destroys the overlays.
   Lower priority (the whole `IsolationModule` is discarded), but release them for cleanliness /
   to bound within-lifetime.

## How to release one overlay

`MemoryTableModule.destroy` (and the `VirtualTableModule.destroy` contract) is
`destroy(db, pAux, moduleName, schemaName, tableName)`. The overlay's identity is on
`state.overlayTable.tableSchema`:

```
await this.overlayModule.destroy(
  db, undefined,
  overlaySchema.vtabModuleName,   // memory module ignores this; a custom overlay may not
  overlaySchema.schemaName,       // createOverlaySchema spreads baseSchema → base schema name
  overlaySchema.name,             // _overlay_<table>_<id>
);
```

`createOverlaySchema` (`isolation-module.ts:1701`) spreads `...baseSchema`, so `schemaName` and
`vtabModuleName` are the base table's; `name` is the generated overlay name. The default
`overlayModule` ignores `db`/`pAux`/`moduleName`, but a host-injected `config.overlay` might not —
so pass real values, all of which are in scope at every release site.

## Design

- Add one private helper, e.g. `private async releaseOverlayTable(db: Database, state: ConnectionOverlayState): Promise<void>`,
  that runs the `overlayModule.destroy(...)` above. Keep it tolerant of a missing schema
  (defensive; overlays always have one by construction).
- Funnel the map deletes through it so no discard path is missed:
  - `clearConnectionOverlay()` becomes `async`: look up the state, release it, then delete. It is
    only called from `async` contexts (`clearOverlay`, `alterSchema`), so `await` the calls and
    make `clearOverlay()` async too — thread the `await` up through `rollback`,
    `onConnectionRollback`, `onConnectionRollbackToSavepoint`, `alterSchema`.
  - `commitConnectionOverlays()`: release each `entries[i].state` and each `orphanedCleanKeys`
    overlay before/at its `delete`.
  - `destroy()`: release on the delete branch (own overlay + foreign clean).
  - `adoptRebuiltOverlay()`: after `this.connectionOverlays.set(key, await rebuild())` succeeds,
    release the OLD `oldState.overlayTable`. (Do NOT release on the throw path — the old overlay
    stays installed there.)
  - `rebuildOverlayForIndexChange()` / `migrateOverlayForAlter()`: wrap the insert loop; on throw,
    `await this.overlayModule.destroy(...)` the freshly built `newOverlayTable`, then rethrow.
  - `closeAll()`: iterate `connectionOverlays.values()` and release each before `.clear()`.

## Integration risk to verify (do not skip)

The overlay `MemoryTable` may have a `MemoryVirtualTableConnection` registered with the
`Database` (pre-registered in `ensureOverlay` when savepoints predate the overlay, or created in
`buildConnection`). Destroying the overlay's manager while that connection is still registered
must not throw when the db later tears the connection down. `MemoryTableManager.disconnect`
already tolerates a connection "disconnected from the manager"
(`packages/quereus/src/vtab/memory/table.ts:95`), which is a good sign, but confirm with the test
below that a commit/rollback cycle involving savepoints does not blow up. If it does, prefer
gating/guarding the teardown ordering over reintroducing the leak.

## `preOverlaySavepoints` — the ticket's secondary question

Same map shape, keyed identically, populated lazily by `getPreOverlaySavepoints()`. But it holds
only `Set<number>` (savepoint depths), not rows, and it **is** reliably cleared at transaction
end: `onConnectionCommit` / `onConnectionRollback` both call `clearPreOverlaySavepoints`
(isolated-table ~1689/1698), and `destroy()` sweeps it (~lines 834-836). So it is not a
row-holding leak. Leave its logic as-is; just make sure any new release path keeps its existing
cleanup intact. Not worth new machinery — note this conclusion in the review handoff.

## Regression test

Add to `packages/quereus-isolation/test/isolation-layer.spec.ts` (Vitest). `overlayModule` is a
public field on `IsolationModule` and `MemoryTableModule.tables` is a public `Map`, so assert the
count directly. Capture `overlayModule.tables.size` as a baseline (0 for a fresh module with a
`MemoryTableModule` overlay), then assert it returns to baseline after each cycle:

- write + commit
- write + rollback
- write + `create index` (rebuild) + commit
- write + `drop index` (rebuild) + commit
- write + `alter table … add column` + commit
- write + `drop table`
- (rebuild-failure) a `create index … unique` over pending duplicate rows in a foreign
  connection's overlay — the poisoned overlay is released when that connection rolls back; the
  issuer's cycle leaves no extra table.

The assertion that pins the whole class of bug: **`overlayModule.tables.size` is back to its
baseline after every cycle above.**

## TODO

- [ ] Add `releaseOverlayTable(db, state)` helper on `IsolationModule`.
- [ ] Make `clearConnectionOverlay` async (release-then-delete); thread `await` through
      `clearOverlay`, `rollback`, `onConnectionRollback`, `onConnectionRollbackToSavepoint`,
      `alterSchema`.
- [ ] Release in `commitConnectionOverlays` (both delete loops).
- [ ] Release in `destroy` (delete branch only; leave surviving poisoned overlays).
- [ ] Release the OLD overlay in `adoptRebuiltOverlay` after a successful rebuild.
- [ ] Release the half-built NEW overlay on throw inside `rebuildOverlayForIndexChange` and
      `migrateOverlayForAlter`.
- [ ] Release all overlays in `closeAll` before clearing the map.
- [ ] Add the baseline-count regression test in `isolation-layer.spec.ts`.
- [ ] `yarn workspace @quereus/quereus-isolation test` green; `yarn build`; `yarn lint`.
- [ ] Confirm the savepoint-involving cycle does not throw on overlay teardown ordering.
