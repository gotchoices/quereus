description: Dropping or renaming a persistent-store materialized view many times still slowly leaks memory, because each old backing-table object stays referenced by a stale database connection that is never cleaned up.
prereq:
files:
  - packages/quereus-store/src/common/backing-host.ts          # connect() stamps owner = this.table (the StoreTable)
  - packages/quereus-store/src/common/store-connection.ts       # owner field pins the StoreTable; tableName is the SIMPLE name
  - packages/quereus-store/src/common/store-table.ts            # super(... tableSchema.name) → VirtualTable.tableName is unqualified
  - packages/quereus/src/core/database.ts                       # removeConnectionsForTable (qualified-name match) / getConnectionsForTable (matches simple too) / unregisterConnection (defined, never called)
  - packages/quereus/src/schema/manager.ts                      # dropTable → removeConnectionsForTable(schemaName, tableName)
  - packages/quereus/src/runtime/emit/alter-table.ts            # rename → removeConnectionsForTable(schemaName, tableName)
difficulty: medium
----

# Residual StoreTable leak: backing-host connections pin the evicted instance via `owner`

## Context

Sibling fix `store-coordinator-stats-callback-leak` (now in `complete/`) removed ONE
of the two paths that pinned an evicted `StoreTable` after a drop / recreate / rename:
the module-wide `TransactionCoordinator` no longer holds the table's stats-callback
closures forever (a disposer is run at `StoreTable.dispose()`).

Reviewing that fix surfaced a SECOND, parallel pinning path that it does not address.
Both leaks share a root cause: the module-wide-coordinator refactor moved "which
incarnation is this" identity off the (formerly per-table) coordinator and onto the
`StoreTable` instance — so anything that captures the instance now pins it.

## The leak

`StoreBackingHost.connect()` (backing-host.ts) mints connections for a
`create materialized view … using store` (and `create table … maintained as … using store`)
backing table:

```ts
connect(): VirtualTableConnection {
  return new StoreConnection(this.table.tableName, this.coordinator, this.table);
  //                                                                  ^^^^^^^^^^ owner = the StoreTable
}
```

`StoreConnection.owner` is a hard reference to the `StoreTable`. The connection is
registered with the engine (`Database.registerConnection` → `activeConnections` map).
`ownsConnection` uses `conn.owner === this.table` for incarnation identity, so the
design *relies on* stale connections lingering after a drop — it rejects them by
identity rather than removing them.

The problem: those stale connections are **never removed from `activeConnections`**
until the whole `Database` closes, so the evicted `StoreTable` stays reachable
(`Database → activeConnections → StoreConnection.owner → StoreTable`) for the
database's lifetime. One leaked `StoreTable` per drop/recreate/rename of an
MV-using-store — exactly the shape the sibling ticket fixed for the coordinator path,
but for MV backings the instance is still pinned.

### Why the connections are never removed

Two engine facts combine:

1. **`Database.unregisterConnection(connectionId)` is defined but never called**
   anywhere in the engine runtime (only referenced by its interface, a test, and
   docs). So there is no per-statement/per-transaction connection teardown.

2. **`Database.removeConnectionsForTable(schemaName, tableName)`** — the only
   per-table cleanup, called from `schema/manager.ts` `dropTable` and
   `alter-table.ts` rename — matches strictly on the **qualified** name:

   ```ts
   conn.tableName.toLowerCase() === `${schemaName}.${tableName}`.toLowerCase()
   ```

   But `StoreConnection.tableName` is the **simple** name: `StoreTable` calls
   `super(db, module, tableSchema.schemaName, tableSchema.name)`, so
   `VirtualTable.tableName` is `tableSchema.name` (`churn`, not `main.churn`).
   `'churn' === 'main.churn'` is false → store connections are never matched, never
   removed. (The memory module avoids this: it registers its connection with the
   *qualified* name — `new MemoryVirtualTableConnection(qualifiedName, …)` — so
   `removeConnectionsForTable` matches and memory connections ARE cleaned up.)

   Note the asymmetry with `getConnectionsForTable`, which DOES match the simple
   name (it strips the schema prefix and compares against both) — so the lookup that
   *reuses* a connection finds it, but the cleanup that *removes* it does not.

## Scope / severity

- **MV-using-store backings (`owner` set): real `StoreTable` leak.** The heavy
  instance is pinned for the db lifetime, bounded by drop/recreate/rename count.
- **Regular store tables (`owner` undefined): NOT a `StoreTable` leak** — the lingering
  connection holds only a simple-name string + the shared coordinator, so the
  instance is freed once the coordinator callback is deregistered (the sibling fix).
  But stale `StoreConnection` objects still accumulate in `activeConnections`
  unboundedly, and `getConnectionsForTable` can return a stale connection for a
  recreated same-named regular table — worth confirming that is benign (the
  coordinator is module-wide, so a reused stale connection may be harmless, but this
  has not been verified).

Not a correctness bug for either case (incarnation identity is enforced by
`ownsConnection`); a memory leak + unbounded `activeConnections` growth.

## What to decide / investigate

Pick the right fix point — each has trade-offs to weigh with the dev:

- **Align store connection naming**: have `StoreConnection`/`StoreTable` register
  with the qualified name so the existing `removeConnectionsForTable` matches (like
  memory). Smallest change, but audit every `conn.tableName` consumer for the
  simple-vs-qualified assumption (e.g. event shaping, `getConnectionsForTable`).
- **Make `removeConnectionsForTable` match the simple name too** (mirror
  `getConnectionsForTable`'s normalization). Engine-wide; confirm it cannot evict a
  legitimately-live connection for a same-named table in another schema.
- **Have the store eviction sites remove their own connections**: at
  `tearDownTableStorage` / `renameTable`, drive removal of the evicted instance's
  connections from the database (requires a `Database` handle + a removal API that
  matches by `owner` identity, not name).

Reproduce first: drop/recreate a `create materialized view … using store` N times in
one db session and assert `getAllConnections()` (or a heap retainer walk) does not
grow O(N). The sibling ticket's `coordinator-callback-leak.spec.ts` is the template;
extend it to the MV-using-store path and assert on connection count / StoreTable
reachability rather than `callbackCount`.
