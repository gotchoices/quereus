---
description: Renaming a table in the middle of a transaction throws away that transaction's writes when the table is stored on disk — the commit reports success but nothing was saved, and later reads on the same connection keep showing the rows as if they had been.
prereq:
files: packages/quereus-store/src/common/store-module.ts (renameTable ~1823), packages/quereus-store/src/common/store-connection.ts, packages/quereus/src/core/database.ts (~1900), packages/quereus/src/core/database-internal.ts (~147), packages/quereus-store/test/isolated-store.spec.ts, packages/quereus-store/test/backing-connection-leak.spec.ts, docs/design-isolation-layer.md
difficulty: medium
---

# Rename inside a transaction discards the transaction's writes (disk-backed tables)

Reproduced and root-caused. The fix below is prototyped: with it applied, the full
`quereus-store` suite (761 tests, including the rename connection-leak regression)
passes and a fresh reproducing test goes green. The prototype was reverted; this
ticket is to land it properly, with the doc note and the regression tests.

## Confirmed reproduction

Against `createIsolatedStoreModule` over a key-value provider that implements
`renameTableStores`:

```ts
await db.exec(`create table widget (id integer primary key, name text) using store`);
await db.exec('begin');
await db.exec(`insert into widget values (1, 'a')`);
await db.exec(`alter table widget rename to gadget`);
await db.exec('commit');                       // reports success

db.eval(`select * from gadget`)            // → [{id: 1, name: 'a'}]   (the staged overlay, still alive)
db.eval(`select * from committed.gadget`)  // → []                     (nothing reached storage)
```

## Root cause — confirmed by probe, not inferred

`StoreModule.renameTable` (store-module.ts ~1823) evicts **every** engine connection
registered under the old qualified name:

```ts
(db as DatabaseInternal).removeConnectionsForTable(schemaName, oldName);
```

`Database` commits a transaction by iterating `getAllConnections()` and calling
`commit()` on each — the loop is name-agnostic; it does not look tables up by name
(`database-transaction.ts` ~272). So the *only* thing that drives
`IsolationModule.commitConnectionOverlays` is the presence of a registered
`IsolatedConnection`. Evicting it means the commit loop reaches nobody, the staged
overlay is never flushed and never cleared, and it survives as a zombie that merges
into every subsequent read on that connection.

Two probes nail this down:

- Deleting the `removeConnectionsForTable` call → the reproducing test passes
  (`committed.gadget` returns the row), and exactly one existing test fails:
  `backing-connection-leak.spec.ts` → "connections are evicted on rename (no orphan
  per rename)" (7 connections instead of 1).
- So the eviction is load-bearing for the **store's own** connections, and fatal for
  the **wrapper's** connection. It cannot stay as a blanket name-keyed sweep.

At rename time, connections registered under `main.widget` are:

| Connection | Created by | State it owns | Correct disposition |
|---|---|---|---|
| `StoreConnection` | `StoreTable.ensureCoordinator`, `StoreBackingHost.connect` | nothing — it delegates to the module-wide `TransactionCoordinator`, which `renameTable` already DDL-committed | evict (its owning `StoreTable` is disposed; a fresh one mints a new connection) |
| `IsolatedConnection` | `IsolatedTable.buildConnection` | the transaction's unflushed overlay | **must survive** — it is the only thing that reaches `commitConnectionOverlays` |

## The fix

`StoreModule` should evict only the connections *it created*, not every connection
that happens to carry the old table name. `StoreConnection` is a concrete class the
store module owns, so the discriminator is a plain `instanceof` — no wrapper
detection, no "can the module see its wrapper" fragility.

In `StoreModule.renameTable`, replace the blanket call with:

```ts
const oldQualified = `${schemaName}.${oldName}`.toLowerCase();
for (const conn of (db as DatabaseInternal).getAllConnections()) {
    if (conn instanceof StoreConnection && conn.tableName.toLowerCase() === oldQualified) {
        (db as DatabaseInternal).removeConnection(conn.connectionId);
    }
}
```

This needs one new engine method, because `unregisterConnection` defers during an
implicit transaction (and a bare `alter table` runs inside one), which is exactly why
`removeConnectionsForTable` exists in the first place:

```ts
// DatabaseInternal + Database
/** Force-removes one connection by id, bypassing the implicit-transaction deferral
 *  that unregisterConnection honours. */
removeConnection(connectionId: string): void;
```

Compare qualified names exactly — do **not** route this through
`getConnectionsForTable`, which also matches on the bare unqualified name and would
reach a same-named table in another schema.

Note `StoreConnection` matches both the `StoreTable`-owned DML connection and the
`StoreBackingHost`-owned connection (materialized-view backings), which the old
name-keyed sweep also caught. Both are safe to evict for the same reason: their
coordinator is module-wide and was DDL-committed a few lines earlier, and their
`owner` `StoreTable` is disposed.

## What is deliberately left alone

**The surviving `IsolatedConnection` keeps its old `tableName`.** Verified by probe;
the consequences are benign and match what the memory path already does today
(`MemoryTableModule.renameTable` never evicted anything):

- The `commit()` path is unaffected: `IsolatedTable.onConnectionCommit` calls
  `commitConnectionOverlays(db)`, which is db-wide and resolves overlays by their
  already-rekeyed keys. The callback's own stale `tableName` is used only for
  `clearPreOverlaySavepoints`, which the sibling ticket
  `iso-preoverlay-savepoints-stranded-by-rename` established must stay on the old name.
- A ping-pong rename `a→b→a→b` settles at two registered `IsolatedConnection`s (one
  per name) rather than growing — `buildConnection`'s covering-reuse finds the old
  one again when the name swings back.
- Renaming away and then recreating a table under the old name with a *different*
  column layout was probed explicitly (`create table a; rename a→b; create table a
  (different columns); insert into a`) and behaves correctly: reads and writes go
  through the freshly-connected `IsolatedTable`, never through the stale connection's
  callback.

A rename to a *fresh* name does leak one `IsolatedConnection` per rename. Record this
as a tripwire (`NOTE:` at the eviction site in `store-module.ts`), not a ticket: it is
bounded by the number of distinct names a table is ever renamed to in one process, it
is pre-existing on the memory path, and fixing it properly means retargeting a
connection's `readonly tableName` across a rename — an engine-wide interface change
that is not worth carrying for this bug.

## Semantics to write down

`StoreModule.renameTable` already DDL-commits the whole module coordinator (every
table's pending ops, not just the renamed table's) before it relocates storage. That
means a mid-transaction `alter table … rename to` on a store-backed table **is** a
partial commit of the store module's pending writes, by construction — the physical
directory move cannot be rolled back through the coordinator. This fix does not change
that; it makes the isolation layer's staged rows land in the same batch instead of
being dropped.

Rollback after a mid-transaction rename still discards the overlay (the overlay is
cleared by `IsolatedConnection.rollback` → `onConnectionRollback`), even though the
store's own pre-rename ops were already DDL-committed. That asymmetry is inherited
from the existing store rename semantics, not introduced here — say so in the doc note
rather than silently leaving it.

Document both points in `docs/design-isolation-layer.md`, next to the *Invariant: every
staged overlay resolves to an underlying table at commit* section.

## Test notes

Regression coverage goes in `packages/quereus-store/test/isolated-store.spec.ts`. Its
`createInMemoryProvider` helper does **not** implement `renameTableStores`, so it must
be extended — copy the implementation from `alter-table.spec.ts` (~line 61), which
relocates the data store and exactly the named index stores.

Assert through `committed.<table>` or through the storage module directly. A plain
`select` on the writing connection passes even with the bug present — the abandoned
overlay masks the loss. That is the whole reason this went unnoticed.

The existing placeholder `describe('mid-transaction RENAME TO with staged writes')`
block (isolated-store.spec.ts ~200) asserts only the parts that work today and carries
a `NOTE:` pointing at this ticket; fold the new assertions into it and drop the NOTE.

## TODO

- Add `removeConnection(connectionId: string): void` to `DatabaseInternal`
  (`packages/quereus/src/core/database-internal.ts`) and implement it on `Database`
  (`packages/quereus/src/core/database.ts`, beside `removeConnectionsForTable`) —
  force-remove by id, bypassing implicit-transaction deferral.
- In `StoreModule.renameTable`, replace the `removeConnectionsForTable(schemaName,
  oldName)` call with the `instanceof StoreConnection` + exact-qualified-name sweep
  above. Import `StoreConnection` from `./store-connection.js` (currently only the
  type-side is reachable there). Rewrite the block comment: the current one asserts
  "no uncommitted writes to lose", which is false under a wrapper.
- Add a `NOTE:` tripwire at that site: a rename onto a never-before-used name leaves
  one stale-named covering connection registered per rename; if a workload renames a
  table through many distinct names in one process, retarget the connection instead.
- Extend `createInMemoryProvider` in `packages/quereus-store/test/isolated-store.spec.ts`
  with `renameTableStores`.
- Regression tests in the existing `mid-transaction RENAME TO with staged writes` block:
  - `begin; insert; rename; commit` → rows readable through `committed.<newName>`.
  - same, but read from a **fresh** `Database` over the same provider (rehydrate) —
    proves the row is physically stored, not just cached.
  - `begin; insert; rename; rollback` → `committed.<newName>` empty, and a plain
    `select` on the writing connection is also empty (no zombie overlay survives).
  - two renames inside one transaction (`w→x→y`, with an insert between) → both rows
    land under `y`. Verified working under the prototype.
  - the connection registered for the old name is gone after the rename, and no
    `StoreConnection` for the old name remains registered.
- Confirm `backing-connection-leak.spec.ts` → "connections are evicted on rename (no
  orphan per rename)" still passes (it is the guard that the eviction still happens for
  store-owned connections).
- Doc note in `docs/design-isolation-layer.md`: mid-transaction rename on a store-backed
  table is a partial commit of the module coordinator; rollback still discards the
  overlay; the "every staged overlay resolves to an underlying at commit" invariant now
  also depends on the wrapper's connection surviving the underlying module's rename.
- Run `yarn workspace @quereus/quereus run build` before the store suite —
  `quereus-store` tests resolve `@quereus/quereus` from `dist/`, so an engine-side
  change is invisible to them until it is built.
- Validate: `yarn workspace @quereus/quereus-store run test` and `yarn test`.
