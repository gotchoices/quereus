description: Fix a stale source-table read mid-transaction after an in-transaction `alter table … add column` when a materialized view over that source exists. A source connection that is detached from its MemoryTableManager's `connections` map but still registered in the Database connection registry keeps a stale pre-alter `readLayer` (old column shape) because `ensureSchemaChangeSafety` only re-points connections in the manager map. The same-transaction read (and any later read / row-time maintenance) then sees the pre-alter row shape, which `refresh materialized view <select * over T>` fills into the backing as stale/misaligned data.
files: packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus/src/vtab/memory/table.ts, packages/quereus/src/vtab/memory/connection.ts, packages/quereus/test/logic/51-materialized-views.sqllogic, packages/quereus/test/logic/53.1-materialized-view-write-through.sqllogic
----

## Root cause (confirmed by reproduction + instrumentation)

`MemoryTableManager.ensureSchemaChangeSafety()` (consolidate-to-base + re-point connections),
called at the top of every memory-table schema change (`addColumn`, `dropColumn`,
`addConstraint`, `dropConstraint`, `renameColumn`, `alterColumn`, `replaceBaseLayer`), only
re-points connections it still holds in its own `connections` map:

```ts
for (const connection of this.connections.values()) {
    if (connection.readLayer !== this.baseLayer) connection.readLayer = this.baseLayer;
}
```

A `MemoryTableConnection` can legitimately be **detached** from that map (removed by
`disconnect()` after an autocommit-driven layer collapse) while remaining **registered** in
the `Database` connection registry (`db.getConnectionsForTable`). `MemoryTable.ensureConnection`
(table.ts:80–118) reuses exactly such a connection for a later scan. After an
**in-transaction** `alter table add column`, `ensureSchemaChangeSafety` consolidates to a
**new** `BaseLayer` (with the new column) but never re-points the detached connection, so it
keeps a `readLayer` pointing at the old, pre-alter layer carrying the OLD schema (3 columns).
`ensureConnection` then refuses to refresh that `readLayer` because the reset is gated on
`!explicitTransaction && !pendingTransactionLayer` — and we are inside an explicit
transaction — so the scan reads the stale 3-column shape.

**Why MV presence is the trigger:** creating/maintaining an MV over the source leaves a
detached-but-registered source connection around (its autocommit layer was collapsed and the
manager disconnected it from its map, but the Database registry kept it). With no MV, no such
detached connection exists; the only registered connection stays in the manager map and IS
re-pointed, so the same read is correct. This is *not* a SQL-text statement-cache issue.

Instrumented reproduction (mid-txn, after `alter`):

| case      | registered conn | `inMgrMap` | `readLayer` cols          | read result |
|-----------|-----------------|-----------|---------------------------|-------------|
| no MV     | conn#1          | true      | id,customer_id,amt,**extra** | `extra='x'` ✓ |
| with MV   | conn#3          | **false** | id,customer_id,amt (stale) | `extra` missing ✗ |

The catalog and freshly-derived plans are correct (4 columns) throughout; only the data-layer
read is stale, which is why the planner expects 4 columns but the scan yields 3-element rows
and the MV refill misaligns (`extra` ends up holding `c.id` etc.).

## Fix (validated — applied, repro fixed, full suite green, then reverted for this stage)

Re-point **all** Database-registered memory connections backed by this manager — including
detached ones — at the new base layer inside `ensureSchemaChangeSafety`, guarded on
`pendingTransactionLayer === null` so no in-flight writes are discarded (a detached connection
always satisfies this: `disconnect()` defers while a pending layer is uncommitted). This fixes
the issue at its source, so reads, writes, and row-time maintenance all observe the post-alter
base uniformly — not just the scan path through `ensureConnection`.

In `packages/quereus/src/vtab/memory/layer/manager.ts`, after the existing
`this.connections.values()` re-point loop in `ensureSchemaChangeSafety`, add a call to a new
helper and the helper itself:

```ts
// (after the existing connections-map loop, before the final debugLog)
//
// The manager's `connections` map covers only connections still attached to this
// manager. A connection can be DETACHED from the map (removed by disconnect after an
// autocommit collapse) while remaining REGISTERED in the Database connection registry —
// `MemoryTable.ensureConnection` reuses exactly such a connection for a later scan. The
// loop above misses it, so after an in-transaction schema change (e.g. ALTER TABLE ADD
// COLUMN, now permitted inside an explicit transaction) it keeps reading a stale
// pre-change layer carrying the OLD column shape — the materialized-view-source-stale-read
// bug. A detached connection always has `pendingTransactionLayer === null` (disconnect
// defers while a pending layer is uncommitted), so this never discards in-flight writes.
this.repointRegisteredConnections();
```

```ts
/**
 * Re-point every Database-registered {@link MemoryTableConnection} backed by this
 * manager (including ones detached from {@link connections}) at the current base layer,
 * when it carries no uncommitted pending layer. Companion to the `connections`-map sweep
 * in {@link ensureSchemaChangeSafety}: it closes the gap for a connection that lives in
 * the Database registry but not in the manager's map.
 */
private repointRegisteredConnections(): void {
    const qualifiedName = `${this.schemaName}.${this._tableName}`;
    for (const c of this.db.getConnectionsForTable(qualifiedName)) {
        if (!(c instanceof MemoryVirtualTableConnection)) continue;
        const mc = c.getMemoryConnection();
        if (mc.tableManager !== this) continue;
        if (mc.pendingTransactionLayer !== null) continue;
        if (mc.readLayer === this.baseLayer) continue;
        logger.debugLog(`[Schema Safety] Re-pointing registered connection ${mc.connectionId} to base layer`);
        mc.readLayer = this.baseLayer;
    }
}
```

Add the import (the wrapper class lives one directory up from `layer/`, imports only types,
so there is no import cycle and `yarn typecheck` passes):

```ts
import { MemoryVirtualTableConnection } from '../connection.js';
```

This pattern (unwrap `MemoryVirtualTableConnection` → `getMemoryConnection()` →
`tableManager === this`) already exists in `core/database-materialized-views.ts`
(`getBackingConnection`).

## Secondary cleanup (now-false comment)

`MemoryTable.ensureConnection` (packages/quereus/src/vtab/memory/table.ts:97–107) justifies
skipping the `readLayer` reset during an explicit transaction with: *"Schema changes can't
happen during a transaction (ensureSchemaChangeSafety throws on active transactions), so
staleness is not a concern here."* That premise is **false** — in-transaction `ALTER ADD
COLUMN` works and is the whole bug. With the manager-side fix the staleness is resolved
upstream (the detached connection's `readLayer` is already current by the time
`ensureConnection` reuses it), so this code does not need behavioural change, but the comment
must be corrected to say that an in-transaction schema change re-points registered connections
via `ensureSchemaChangeSafety` (so reuse here observes the current base), rather than claiming
schema changes cannot occur in a transaction.

## Out of scope / noted, do not fix here

`begin; insert into <source>; alter table <source> add column; …` (a write *then* an
in-transaction schema change on the SAME connection, which has an uncommitted pending layer
built on the old schema) is a distinct, pre-existing concern independent of materialized
views — `repointRegisteredConnections`'s `pendingTransactionLayer === null` guard deliberately
leaves it untouched. Do not widen scope to it in this ticket.

## TODO

- [ ] Add the import and `repointRegisteredConnections()` helper + call in
  `ensureSchemaChangeSafety` (manager.ts) as specified above.
- [ ] Correct the now-false "schema changes can't happen during a transaction" comment in
  `MemoryTable.ensureConnection` (table.ts).
- [ ] Add a regression test exercising both:
  (a) `begin; alter table orders add column extra text default 'x'; refresh materialized view v; commit;`
  then `select * from v` shows `extra='x'` (not a misaligned/leaked value); and
  (b) the plain same-transaction read `begin; alter table orders add column …; select * from orders; commit;`
  (with an MV over `orders` present) returns the new column with its backfilled default.
  Prefer extending `test/logic/51-materialized-views.sqllogic` and/or
  `test/logic/53.1-materialized-view-write-through.sqllogic`; the join-MV `select *` body from
  the original repro (orders ⋈ customers) is the sharpest reproducer. Confirm the test FAILS
  on `main` (pre-fix) and passes after.
- [ ] `yarn workspace @quereus/quereus run typecheck`, then `yarn test` (memory) — confirm the
  full `logic.spec.ts` (223) + alter/MV/transaction specs stay green.
- [ ] If touching docs: `docs/materialized-views.md` (reads-own-writes / source consistency)
  is the most relevant; a one-line note that an in-transaction source schema change re-points
  all registered source connections is sufficient — no large doc rewrite.
