---
description: Every transaction that writes to a table leaves behind a small in-memory staging table that is never freed, so a long-lived database connection slowly grows its memory use with no upper bound.
files:
  - packages/quereus-isolation/src/isolation-module.ts   # overlayModule.create call sites; clearConnectionOverlay
  - packages/quereus-isolation/src/isolated-table.ts     # ensureOverlay
  - packages/quereus/src/vtab/memory/module.ts           # MemoryTableModule.tables map; only destroy() removes an entry
difficulty: medium
---

# Isolation overlay tables are created but never destroyed

## What happens

The isolation layer stages each connection's uncommitted writes in a private in-memory table —
an *overlay* — created through a `MemoryTableModule` instance it owns
(`IsolationModule.overlayModule`). `MemoryTableModule.create()` registers the new table in the
module's internal `tables` map, keyed by a name unique per overlay
(`_overlay_<table>_<counter>`). The only thing that removes an entry from that map is
`MemoryTableModule.destroy()`.

The isolation layer never calls `destroy()` on an overlay. When a transaction ends,
`clearConnectionOverlay()` simply drops the layer's own reference
(`connectionOverlays.delete(key)`), and the overlay's `MemoryTableManager` — with whatever rows
it still holds — stays reachable from `overlayModule.tables` forever.

So the map grows by one entry per (connection, table) overlay, i.e. roughly once per writing
transaction, for the life of the `Database`. It also grows on every overlay *rebuild*: `ALTER
TABLE`, `CREATE INDEX`, and `DROP INDEX` each construct a replacement overlay and abandon the
old one; a rebuild that fails abandons the half-built replacement instead.

## Why it matters

A long-running process — a server holding one `Database` across thousands of transactions —
accumulates one dead in-memory table per transaction, each still holding its staged rows. There
is no eviction and no bound. This is a plain leak, not a caching tradeoff.

## Expected behavior

An overlay's storage is released as soon as the layer stops referencing it:

*   when a transaction commits or rolls back (`clearConnectionOverlay`),
*   when a rebuild installs a replacement (the old overlay),
*   when a rebuild fails (the abandoned replacement),
*   when the underlying table is dropped or the database is closed.

## Notes

Pre-existing; not introduced by any recent change, though the `CREATE INDEX` overlay rebuild
added by `isolation-ddl-validation-ignores-overlay-rows` made it fire more often.

Worth checking at the same time whether `IsolationModule.preOverlaySavepoints` has the same
shape — it is a map keyed the same way and is populated lazily.

A test that asserts the overlay module's table count returns to its baseline after a
commit / rollback / rebuild cycle would pin all of the above.
