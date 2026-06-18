description: Fixed a memory leak where persistent-store table connections were never evicted when the table was dropped or renamed, so each drop/rename left a dead connection behind forever.
files:
  - packages/quereus-store/src/common/backing-host.ts            # connect() uses qualified name (implement)
  - packages/quereus-store/src/common/store-table.ts             # ensureCoordinator() uses qualified name (implement)
  - packages/quereus-store/src/common/store-module.ts            # renameTable() now evicts the stale connection (review)
  - packages/quereus/src/core/database-internal.ts               # removeConnectionsForTable added to DatabaseInternal (review)
  - packages/quereus-store/test/backing-connection-leak.spec.ts  # drop + DML + rename regression tests
----

## Summary

A store-backed table registers an engine `VirtualTableConnection` (under
`Database.activeConnections`) the first time it writes (`StoreTable.ensureCoordinator`)
and whenever the materialized-view backing host connects (`StoreBackingHost.connect`).
The engine's per-table cleanup, `Database.removeConnectionsForTable`, matches on the
**schema-qualified** name (`main.t`), but both store mint sites used the **bare** table
name (`t`), so the cleanup never matched and every dropped/renamed store table left a
dead connection alive for the db lifetime — leaking memory and (for MV backings)
pinning the whole evicted `StoreTable` instance.

The implement stage aligned both mint sites with the qualified convention the memory
module already uses (`${schemaName}.${tableName}`). That fixed the **drop** path (the
engine's schema manager calls `removeConnectionsForTable` on drop). The review found
that the **rename** path was NOT actually covered — see findings below — and fixed it.

## Review findings

### What was checked

- **Implement diff, fresh eyes** — both one-line mint-site changes
  (`backing-host.ts` `connect`, `store-table.ts` `ensureCoordinator`). Both correct;
  `schemaName` is a public readonly field on the `VirtualTable` base, so both call
  sites compile and resolve the right value.
- **Engine cleanup/lookup machinery** — `removeConnectionsForTable` (qualified-only
  match), `getConnectionsForTable` (matches qualified OR bare via simpleName fallback),
  `getVTableConnection`, `findConnection`. Confirmed the qualified naming is the
  convention every consumer already tolerates, and that it additionally *fixes* a
  latent cross-schema correctness bug: with bare names, `getConnectionsForTable('main.t')`
  would also match a connection for `aux.t` (both named `t`); qualified names
  disambiguate.
- **All `new StoreConnection` mint sites** — only the two fixed ones exist; no third
  bare-name site lurking.
- **Every `removeConnectionsForTable` / module-rename call site** — drop
  (`schema/manager.ts`), memory rekey-rebuild (`alter-table.ts:1252`), and the generic
  rename path (`alter-table.ts` `renameTableImpl`, line ~192).
- **Docs** — no architecture/design doc documents the connection-naming or per-table
  cleanup convention (only ticket files mention it); the change tracks the memory
  module's existing code convention, so nothing to update. *(Verified, not assumed.)*

### Major finding — fixed inline (rename leak was NOT fixed by implement)

The implement handoff claimed the fix "covers both leak shapes because
`removeConnectionsForTable` already ran on every drop/rename." **The rename half is
false.** The generic engine rename path (`alter-table.ts` `renameTableImpl`) calls
`module.renameTable` but, unlike the drop path, does **not** call
`removeConnectionsForTable`. The store's own `StoreModule.renameTable` disposes the old
`StoreTable` and deregisters its coordinator callbacks, but never evicted the registered
engine connection. So a store `alter table … rename to …` still leaked exactly one
connection per rename — the same leak class the ticket exists to fix, just on a
different DDL verb.

Confirmed empirically with a probe (6 ping-pong renames over a baseline of 1 →
`getAllConnections().length` was **7**, i.e. baseline + one orphan per rename).

**Fix (review, minor-sized + contained, so applied inline rather than re-ticketed):**
`StoreModule.renameTable` now calls `removeConnectionsForTable(schemaName, oldName)`
right after disposing the old instance. This is safe at that point because store rename
is a DDL-commit boundary — the method already flushes the module coordinator
(`moduleCoordinator.commit()`) before disposing, so there are no uncommitted writes to
lose (the same justification the drop path relies on). The store-local site (not the
generic engine path) was chosen deliberately: the generic path intentionally leaves
connections registered for modules like memory that re-key a connection in place across
rename, and may carry in-transaction writes; only the store knows it has already
DDL-committed.

`removeConnectionsForTable` was `@internal` on the concrete `Database` (stripped from
the public `.d.ts`), so the store could not see it. Added it to the exported
`DatabaseInternal` interface — alongside the sibling connection-management methods the
store already consumes via that interface (`registerConnection`,
`getConnectionsForTable`) — and called it through the existing `(db as DatabaseInternal)`
cast.

### Test gaps — closed inline

The implement tests covered drop (MV-backing + ordinary DML) but not rename. Added a
third regression test, `connections are evicted on rename (no orphan per rename)`: a
ping-pong `alter table a rename to b` loop with a write per cycle must keep
`getAllConnections().length` flat at baseline. Fails (7 ≠ 1) without the rename fix,
passes with it.

### Other aspects (SPP / DRY / type safety / resource cleanup / error handling)

- **Resource cleanup** — both leak shapes (drop + rename) now evict; coordinator
  callbacks were already deregistered on both via `dispose`. No remaining
  per-table-incarnation pin.
- **Type safety** — no `any`; the new interface method is fully typed; the `as
  DatabaseInternal` cast mirrors the file's established pattern. No new lint findings.
- **Error handling** — `removeConnectionsForTable` is synchronous and total (deletes
  matching map entries; logs each); placed after the rename's DDL-commit, before
  physical storage move, so a connection-eviction has no failure mode that could strand
  the rename.
- **No regressions found** in the cross-schema, owner-pinning, or DML-connection paths.

### Validation

- `yarn workspace @quereus/store run test`: **659 passing** (was 658; +1 rename test).
- `yarn workspace @quereus/quereus run lint`: **exit 0** (eslint + `tsc -p
  tsconfig.test.json --noEmit`, which type-checks the `DatabaseInternal` change).
- `yarn workspace @quereus/quereus run build` then `yarn workspace @quereus/store run
  typecheck`: **exit 0** — confirms the store package type-checks against the rebuilt
  engine `.d.ts` carrying the new interface member (the store consumes quereus via
  `dist`, so this is necessary to prove CI consistency).

No pre-existing test failures surfaced.
