---
description: Fixed a bug where renaming a table in the middle of a transaction silently threw away that transaction's writes on disk-backed tables — the commit said success but nothing was saved.
prereq:
files: packages/quereus-store/src/common/store-module.ts (renameTable ~1816), packages/quereus/src/core/database.ts (removeConnection ~1910), packages/quereus/src/core/database-internal.ts (~149), packages/quereus-store/test/isolated-store.spec.ts, docs/design-isolation-layer.md
difficulty: medium
---

# Review: rename inside a transaction no longer discards staged writes

## What was wrong

`StoreModule.renameTable` evicted **every** engine connection registered under the old
qualified name, via `removeConnectionsForTable(schemaName, oldName)`.

`Database` commits by iterating `getAllConnections()` and calling `commit()` on each —
the loop never looks tables up by name. When the store module is wrapped by the
isolation layer, the wrapper's `IsolatedConnection` is registered under that same
qualified name and is the *only* thing that drives `IsolationModule.commitConnectionOverlays`.
Evicting it meant the commit loop reached nobody: the staged overlay was never flushed,
never cleared, and survived as a zombie that merged into every later read on that
connection. `commit` reported success; storage stayed empty.

## What changed

**`packages/quereus/src/core/database.ts` + `database-internal.ts`** — new engine method:

```ts
removeConnection(connectionId: string): void;
```

Force-removes one connection by id, bypassing the implicit-transaction deferral that
`unregisterConnection` honours. (That deferral is why `removeConnectionsForTable`
existed at all: a bare `alter table` runs inside an implicit transaction.)

**`packages/quereus-store/src/common/store-module.ts`** — `renameTable` now evicts only
the connections the store module itself created, discriminated by `instanceof
StoreConnection` plus an exact qualified-name match:

```ts
const oldQualified = `${schemaName}.${oldName}`.toLowerCase();
for (const conn of (db as DatabaseInternal).getAllConnections()) {
    if (conn instanceof StoreConnection && conn.tableName.toLowerCase() === oldQualified) {
        (db as DatabaseInternal).removeConnection(conn.connectionId);
    }
}
```

Exact qualified-name compare, deliberately *not* `getConnectionsForTable` — that also
matches the bare unqualified name and would reach a same-named table in another schema.
`StoreConnection` matches both the `StoreTable`-owned DML connection and the
`StoreBackingHost`-owned one (materialized-view backings); both are safe to evict, since
their coordinator is module-wide and was DDL-committed a few lines earlier and their
owning `StoreTable` is disposed. The block comment was rewritten — the old one asserted
"no uncommitted writes to lose", which is false under a wrapper.

**`docs/design-isolation-layer.md`** — two additions next to *Invariant: every staged
overlay resolves to an underlying table at commit*: (a) the invariant also depends on the
wrapper's connection surviving the underlying module's rename; (b) a new subsection saying
a mid-transaction rename on a store-backed table *is* a partial commit of the module
coordinator by construction, and that rollback still discards the overlay — an asymmetry
inherited from existing store rename semantics, not introduced here.

**`packages/quereus-store/test/isolated-store.spec.ts`** — `createInMemoryProvider` gained
`renameTableStores` (copied from `alter-table.spec.ts`); five regression tests folded into
the existing `mid-transaction RENAME TO with staged writes` block, whose stale `NOTE:`
pointing at this ticket was removed.

## Validation

- `yarn workspace @quereus/store run test` → **765 passing, 0 failing** (was 760 + 5 new).
  Note the workspace is named `@quereus/store`, not `@quereus/quereus-store`.
- `yarn test` (all workspaces) → **0 failing**.
- `yarn workspace @quereus/quereus run lint` → clean (eslint + `tsc -p tsconfig.test.json`).
- `packages/quereus-store` is not type-checked by any lint script; the spec was verified
  separately with a standalone `tsc --noEmit --strict`.
- **Anti-vacuity check**: reverted the store-module change in place and re-ran the block —
  4 of the 5 new tests fail (`flushes staged rows`, `physically stored`, `two renames`,
  `evicts the store-owned connection`). Restored, suite green again. The 5th (ROLLBACK
  discards) passes both before and after, i.e. it is a *guard*, not a reproduction.

## Use cases the tests pin

In `describe('mid-transaction RENAME TO with staged writes')`, against
`createIsolatedStoreModule` over the in-memory KV provider:

- `begin; insert; rename widget→gadget; commit` → row readable through `committed.gadget`.
  (`committed.<table>` bypasses the overlay — a plain `select` on the writing connection
  passed even *with* the bug, which is exactly why this went unnoticed for so long.)
- Same, then read from a **fresh** `Database` + `StoreModule` + `rehydrateCatalog` over the
  same provider → proves the row is physically stored, not cached.
- `begin; insert; rename; rollback` → both `committed.gadget` and a plain `select * from
  gadget` are empty (no zombie overlay survives).
- Two renames in one transaction (`widget→gizmo→gadget`, insert between) → both rows land
  under `gadget`.
- After the rename, no `StoreConnection` remains registered for `main.widget`, and at least
  one connection (the isolation layer's) *does* — the precise shape of the fix.
- `backing-connection-leak.spec.ts` → "connections are evicted on rename (no orphan per
  rename)" still passes; it is the guard that store-owned connections still get evicted.

## Known gaps / things a reviewer should poke at

- **Deliberately left alone: the surviving `IsolatedConnection` keeps its old `tableName`.**
  This was probed in the fix stage, not just reasoned about. Consequences: `commit()` is
  unaffected (the flush is db-wide and resolves overlays by re-keyed names; the callback's
  stale name is used only for `clearPreOverlaySavepoints`, which the sibling ticket
  `iso-preoverlay-savepoints-stranded-by-rename` established must stay on the old name);
  a ping-pong rename `a→b→a→b` settles at two registered connections rather than growing.
  A rename to a *fresh* name does leak one `IsolatedConnection` per rename. Recorded as a
  `NOTE:` tripwire at the eviction site in `store-module.ts` rather than a ticket: bounded
  by distinct names per process, pre-existing on the memory path (`MemoryTableModule.renameTable`
  never evicted anything), and fixing it properly means retargeting a connection's
  `readonly tableName` — an engine-wide interface change.
- **`instanceof` across module boundaries.** The discriminator assumes one `StoreConnection`
  class identity at runtime. Duplicate copies of `@quereus/store` in a dependency tree would
  silently fail the check (falling back to *not* evicting — the safe direction: a leaked
  connection, not lost data). Not guarded; worth a reviewer's opinion on whether a brand
  property would be better than `instanceof`.
- **No test covers the `StoreBackingHost` connection being evicted on rename of a
  materialized-view-backing table specifically.** `backing-connection-leak.spec.ts` covers
  eviction counts on rename generally; the `owner`-pinned host connection is a
  `StoreConnection` too, so it is caught by the same `instanceof`, but that path is asserted
  by construction rather than by a dedicated test.
- **`removeConnection` is engine-public (`DatabaseInternal`) and unguarded.** Any module can
  now force-evict any connection by id, bypassing the implicit-transaction deferral. That is
  the point, but it is a sharper tool than `removeConnectionsForTable` was.
- **Cross-schema rename** (`main.widget` vs `other.widget`) is handled by the exact qualified
  compare but has no test. The old code used the same qualified compare inside
  `removeConnectionsForTable`, so this is not a regression, just untested in both.
- The doc's new "partial commit" subsection describes semantics that predate this fix. It is
  the first time they are written down; a reviewer who disagrees with the characterization
  should say so, since nothing in code enforces it.
