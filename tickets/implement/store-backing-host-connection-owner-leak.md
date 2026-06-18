description: Persistent-store tables register their engine connection under the bare table name, but the drop/rename cleanup only matches the schema-qualified name, so every dropped/renamed store table leaves a dead connection behind forever — slowly leaking memory.
prereq:
files:
  - packages/quereus-store/src/common/backing-host.ts          # connect() mints the host connection with the SIMPLE name
  - packages/quereus-store/src/common/store-table.ts            # ensureCoordinator() mints the DML connection with the SIMPLE name
  - packages/quereus-store/src/common/store-connection.ts       # StoreConnection.tableName + connectionId derive from the passed name
  - packages/quereus/src/core/database.ts                       # removeConnectionsForTable matches QUALIFIED; getConnectionsForTable normalizes both
  - packages/quereus-store/test/coordinator-callback-leak.spec.ts  # sibling regression test = template (persistent provider helper)
difficulty: easy
----

# Fix: store connections register under the simple name, so `removeConnectionsForTable` never evicts them

## Root cause (confirmed by reproduction)

`Database.removeConnectionsForTable(schemaName, tableName)` — the only per-table
connection cleanup, called from `schema/manager.ts` `dropTable` and
`alter-table.ts` rename — matches strictly on the **qualified** name:

```ts
const qualifiedName = `${schemaName}.${tableName}`.toLowerCase();
if (conn.tableName.toLowerCase() === qualifiedName) { … delete … }
```

But both store-side connection mint sites pass the **simple** name:

- `StoreBackingHost.connect()` → `new StoreConnection(this.table.tableName, …)` (host/MV-backing connection, `owner = StoreTable`)
- `StoreTable.ensureCoordinator()` → `new StoreConnection(this.tableName, …)` (regular DML connection, `owner` undefined)

`VirtualTable.tableName` is the unqualified `tableSchema.name` (`churn`, not
`main.churn`), so `'churn' === 'main.churn'` is always false → **store connections
are never matched and never removed** from `Database.activeConnections` until the
whole db closes. The memory module avoids this by registering with the qualified
name (`vtab/memory/module.ts` `connect()` → `${schemaName}.${tableName}`), so its
connections ARE cleaned up — the store is the lone outlier.

For MV-using-store backings this pins the whole evicted `StoreTable` instance for
the db lifetime (`Database → activeConnections → StoreConnection.owner →
StoreTable`); for regular store tables it accumulates dead `StoreConnection`
objects unboundedly and lets `getConnectionsForTable` hand a stale connection back
for a recreated same-named table.

## Reproduction (done — confirms the diagnosis)

A drop/recreate loop of `create materialized view mv using store as select …`
grew `Database.getAllConnections()` by exactly **+1 per cycle** (baseline 1 →
11 after 10 cycles). With the fix below applied, it stayed flat at baseline (1),
and the **entire 657-test `quereus-store` suite passed unchanged**. The temporary
repro spec was removed after validation; reinstate it as the permanent regression
test below.

## Chosen fix: align store connection naming with the qualified convention (memory parity)

This is the smallest, lowest-risk option of the three the fix ticket weighed, and
it was validated end-to-end (leak gone, full store suite green):

- It fixes **both** leak shapes at once (host-connection `StoreTable` pin AND
  unbounded regular-connection growth), because both eviction sites
  (`schema/manager.ts` drop, `alter-table.ts` rename) already call
  `removeConnectionsForTable` — they were simply never matching.
- It also removes the stale-reuse hazard: after a drop, `getConnectionsForTable` /
  `getVTableConnection` (`runtime/utils.ts`) no longer return a stale simple-name
  match for a recreated table — the connection is gone at drop time.
- Every existing consumer of `conn.tableName` already tolerates the qualified form:
  `removeConnectionsForTable` requires it; `getConnectionsForTable`
  (`database.ts`) and `findConnection` (`runtime/deferred-constraint-queue.ts`)
  normalize and match both simple and qualified. No engine change is needed.

The only observable change is the `connectionId` string, which becomes
`store-main.churn-<n>` instead of `store-churn-<n>` — used only in logs and as an
opaque map key (matched by exact equality in `findConnection`'s `preferredId`
branch), so the format carries no assumptions.

The two rejected alternatives, for the record: (b) making
`removeConnectionsForTable` also match the simple name is engine-wide and risks
evicting a live connection for a same-named table in another schema; (c) driving
removal-by-`owner` from the store eviction sites needs a new `Database` removal API
and still leaves the regular-DML connection (owner undefined) uncleaned. Neither
buys anything (a) doesn't, and both are larger.

## TODO

- In `backing-host.ts` `connect()`, mint the connection with the qualified name:
  `new StoreConnection(`${this.table.schemaName}.${this.table.tableName}`, this.coordinator, this.table)`.
- In `store-table.ts` `ensureCoordinator()`, mint the DML connection with the
  qualified name: `new StoreConnection(`${this.schemaName}.${this.tableName}`, coordinator)`.
  (Both `StoreTable` and `StoreBackingHost` already expose `schemaName`.)
- Add a permanent regression test (new spec, or extend
  `coordinator-callback-leak.spec.ts` — reuse its `createPersistentProvider`
  helper). Assert that a 10× drop/recreate loop of a `create materialized view …
  using store` keeps the database's active-connection count flat at baseline
  (not baseline + N). `getAllConnections()` lives on `DatabaseInternal`; cast as
  the repro did: `(db as unknown as { getAllConnections(): unknown[] })`. Consider
  a second case for a plain `create table … using store` drop/recreate loop.
- Validate: `yarn workspace @quereus/quereus-store run test` (full store suite),
  and `yarn workspace @quereus/quereus run lint` for the engine type-check pass.
  (The store fix is self-contained to the store package; the engine is unchanged,
  but the lint pass is cheap insurance against signature drift.)
