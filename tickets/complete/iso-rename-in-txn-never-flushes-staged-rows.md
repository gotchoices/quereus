---
description: Fixed a bug where renaming a table in the middle of a transaction silently threw away that transaction's writes on disk-backed tables — the commit said success but nothing was saved.
prereq:
files: packages/quereus-store/src/common/store-module.ts, packages/quereus/src/core/database.ts, packages/quereus/src/core/database-internal.ts, packages/quereus-isolation/src/isolated-table.ts, packages/quereus-store/test/isolated-store.spec.ts, packages/quereus-store/test/backing-connection-leak.spec.ts, docs/design-isolation-layer.md, docs/module-authoring.md
difficulty: medium
---

# Complete: rename inside a transaction no longer discards staged writes

## The defect

`StoreModule.renameTable` called `removeConnectionsForTable(schemaName, oldName)`, which force-removes
**every** engine connection registered under that qualified name. When the store module is wrapped by
the isolation layer, the wrapper's `IsolatedConnection` is registered under the same name and is the
only thing that drives `IsolationModule.commitConnectionOverlays`. `Database` commits by iterating
`getAllConnections()` — the loop never looks tables up by name — so evicting the wrapper's connection
left nobody to flush the staged overlay. `commit` reported success, storage stayed empty, and the
abandoned overlay kept merging into every later read on that connection, hiding the loss from a plain
`select`.

## The fix

A new engine method `DatabaseInternal.removeConnection(connectionId)` force-removes one connection by
id, bypassing the implicit-transaction deferral that `unregisterConnection` honours. (That deferral is
why the blanket sweep existed: a bare `alter table` runs inside an implicit transaction.)
`StoreModule.renameTable` now evicts only the connections the store module itself created,
discriminated by `instanceof StoreConnection` **and** an exact qualified-name match — deliberately not
`getConnectionsForTable`, which also matches the bare unqualified name and would reach a same-named
table in another schema.

`StoreConnection` covers both the `StoreTable`-owned DML connection and the `StoreBackingHost`-owned
connection used for materialized-view backings. Both are safe to evict: they hold no state of their
own, delegating to the module-wide `TransactionCoordinator` that the DDL-commit a few lines earlier
already flushed, and their owning `StoreTable` is disposed by then.

## Review findings

### Read first, handoff second

The implement-stage diff (`49018c99`) was read before the handoff summary. The chain that actually
carries a staged row to disk was traced end to end rather than taken on trust:
`IsolatedConnection.commit` → `onConnectionCommit` → `IsolationModule.commitConnectionOverlays` →
`applyOverlayToUnderlying` → `underlyingTable.commit()`. Worth recording, because the durability of a
mid-transaction rename does **not** depend on the store's own `StoreConnection` being present in
`Database`'s commit loop: `commitConnectionOverlays` phase 2 calls `underlyingTable.commit?.()`
directly. That is why evicting every `StoreConnection` is safe, and why evicting the one
`IsolatedConnection` was fatal. The fix is aimed at exactly the right connection.

### Correctness — nothing broken found

The blanket-sweep bug class was hunted elsewhere in the tree. `removeConnectionsForTable` has two
remaining callers: `schema/manager.ts` (drop table, where the table is genuinely going away and no
connection under that name can hold committable state) and `alter-table.ts` `rebuildMemoryTable`
(reached only when the module *is* `MemoryTableModule`, never when it is `IsolationModule`). Neither
can strand a wrapper's connection. No other module calls it.

### Untested behaviour — five gaps closed with new tests

The implementer's tests were a starting point. Five paths they did not cover were probed, all four
initially unknown outcomes turning out correct; the probes were kept as regression tests
(`770 passing` in `@quereus/store`, up from 765):

- **A table recreated under the freed old name.** This is the sharpest consequence of the fix and the
  handoff did not name it: the surviving `IsolatedConnection` keeps the old `tableName` and is
  `isCovering`, so the reuse lookup in `IsolatedTable.buildConnection` hands it to a *different* table
  later created under that freed name. Verified sound (commit and rollback both keep the two tables'
  rows separate) — but sound only because the overlay and underlying maps are keyed by table name,
  not by connection. Two tests added; a `NOTE:` tripwire added at the reuse site.
- **Rename of a table that never registered a `StoreConnection`.** The eviction loop matches nothing;
  later writes must still commit. Test added.
- **Ping-pong rename bound.** The handoff *claims* `a→b→a→b` settles at two registered connections
  rather than growing. Now asserted rather than asserted-in-prose.
- **`StoreBackingHost` connection eviction on rename**, explicitly listed as an untested gap. Test
  added to `backing-connection-leak.spec.ts` (rename a materialized view back and forth; connection
  count must not grow). It is a guard, not a reproduction — it passes against the old code too — but
  it pins the `owner`-pinned host connection to the `instanceof` branch, which is what would break if
  someone narrowed the discriminator.

### Documentation — out of date, now fixed

Treating the docs as stale until read proved correct. The change added a method to the module-author
surface (`DatabaseInternal.removeConnection`) and left `docs/module-authoring.md` — the file that
tabulates exactly that surface for plugin authors — untouched. A future module implementing
`renameTable` would have reached for `removeConnectionsForTable` and reproduced this bug verbatim.
Fixed inline: the table now lists `removeConnection` and `removeConnectionsForTable`, notes that
`getConnectionsForTable` matches the bare name too, and a new **Evicting connections on `renameTable`**
subsection gives the correct pattern and says plainly why the blanket sweep is wrong.

`docs/design-isolation-layer.md` said `StoreModule.renameTable` "evicts by `instanceof
StoreConnection`, not by name". It evicts by *both*; a reader following that sentence would write a
cross-schema bug. Corrected, and cross-linked to the new module-authoring subsection.

### Reviewer opinions the handoff asked for

- **`instanceof` vs. a brand property.** Keep `instanceof`. It is what the codebase already does
  (`StoreBackingHost.ownsConnection`, and the connection-reuse pattern documented in
  `module-authoring.md`), and its failure mode under duplicate copies of `@quereus/store` is to *not*
  evict — a leaked connection, never lost data. A brand would trade a consistent idiom for a marginal
  robustness gain against a dependency-tree shape this monorepo does not produce.
- **`removeConnection` being engine-public and unguarded.** Acceptable. `DatabaseInternal` is already
  a fully-privileged surface — `registerConnection` and `removeConnectionsForTable` are strictly more
  dangerous, the latter being the very method that caused this bug. It is now documented, which is
  the guard that was actually missing.
- **The doc's new "partial commit" subsection.** The characterization is accurate: `renameTable`
  DDL-commits the module-wide coordinator (every table's pending ops) before relocating physical
  stores, because a directory move cannot be rolled back through the coordinator. Nothing in code
  enforces it, but nothing contradicts it either, and writing it down is a strict improvement.

### Accepted without a ticket, with reasons

- **Cross-schema rename** (`main.widget` vs `other.widget`) remains untested. The exact qualified
  compare is correct by inspection, the old code used the same compare, and standing up a second
  schema for one assertion buys little. Not a regression.
- **`packages/quereus-store` test files are type-checked by no lint script.** Pre-existing and
  intentional per `AGENTS.md` (only `packages/quereus` has a real lint). Both edited spec files were
  verified with a standalone `tsc --noEmit --strict` instead.
- **One `IsolatedConnection` leaks per rename to a fresh name.** Bounded by distinct names per
  process, pre-existing on the memory path, and fixing it means retargeting a connection's `readonly
  tableName` — an engine-wide interface change. Left as the implementer's `NOTE:` tripwire in
  `store-module.ts`; the ping-pong test now guards its stated bound.

### Tripwires recorded (not tickets)

- `packages/quereus-isolation/src/isolated-table.ts`, at the covering-connection reuse lookup — a
  table recreated under a freed old name adopts the stale connection; safe only while overlay and
  underlying state is keyed by name rather than by connection.
- `packages/quereus-store/src/common/store-module.ts`, at the eviction site — the pre-existing
  `NOTE:` about one leaked `IsolatedConnection` per rename to a fresh name (left as written).

### Major findings

None. No new ticket was filed: no defect surfaced that the fix does not already handle, and every
concern raised in the handoff resolved either to a documentation gap (fixed here), a missing test
(added here), or a bounded, conditional cost (recorded as a tripwire).

## Validation

- `yarn workspace @quereus/store run test` → **770 passing, 0 failing** (765 at handoff, +5 review tests).
- `yarn test` (all workspaces) → **0 failing**.
- `yarn workspace @quereus/quereus run lint` → clean (eslint + `tsc -p tsconfig.test.json`).
- Both edited spec files type-check standalone under `tsc --noEmit --strict`.
- Implementer's anti-vacuity check reproduced from the handoff: reverting the `store-module.ts` change
  fails 4 of their 5 tests. The two new recreated-under-the-freed-name tests also fail against the old
  code; the ping-pong and MV-backing tests are guards that pass either way, as intended.
