description: Honor `USING <module>(...)` on CREATE MATERIALIZED VIEW so an MV's backing table can live in a module other than memory — abstract the privileged backing-write surface (applyMaintenanceToLayer / replaceBaseLayer / covering conflict lookup) from MemoryTableManager into a module capability.
prereq: store-mv-rehydrate-via-importcatalog
files:
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts   # buildBackingTableSchema hardcodes 'memory'; getBackingManager requires MemoryTableModule
  - packages/quereus/src/runtime/emit/materialized-view.ts           # create/refresh/drop emitters
  - packages/quereus/src/core/database-materialized-views.ts         # all maintenance arms apply via MemoryTableManager.applyMaintenanceToLayer; getBackingConnection types MemoryTableConnection
  - packages/quereus/src/vtab/memory/layer/manager.ts                # BackingRowChange, MaintenanceOp, CoveringStructure vocabulary; applyMaintenanceToLayer / replaceBaseLayer
  - packages/quereus/src/vtab/module.ts                              # module capability surface to extend
  - docs/materialized-views.md                                       # "Backing-module pluggability" under Current limitations
----

# MV backing-module pluggability

## Background

A materialized view's backing table is hardcoded to the in-memory module. The
hardcoding is load-bearing, not cosmetic:

- `buildBackingTableSchema` (`runtime/emit/materialized-view-helpers.ts`) does
  `getModule('memory')` unconditionally; the `USING <module>(...)` clause on
  `CREATE MATERIALIZED VIEW` parses and is retained on the AST but is otherwise
  ignored (documented at `docs/materialized-views.md` § Substrate).
- `getBackingManager` throws unless the backing's vtab module is a
  `MemoryTableModule` instance.
- Every row-time maintenance arm (`database-materialized-views.ts`) applies its
  delta through `MemoryTableManager.applyMaintenanceToLayer(connection, ops)` —
  a privileged write into the connection's pending `TransactionLayer` that
  bypasses `validateMutationPermissions` (backing tables are read-only to user
  DML) and reuses `recordUpsert`/`recordDelete` for secondary-index bookkeeping.
  Create/refresh fill via `MemoryTableManager.replaceBaseLayer`.
- The covering-UNIQUE enforcement path (`_lookupCoveringConflicts`) point-reads
  the backing through the same memory connection.

Consequences downstream (reported from the Lamina repo): a Lamina `RowStore`
can never host an MV's backing, so covering structures over Lamina-backed
tables are memory-resident only — not persisted by the storage module, refilled
from source at create / `apply schema` (see also the related backlog ticket
`store-mv-rehydrate-via-importcatalog`, which works around exactly this by
re-running create DDL on store rehydrate).

This is already named under `docs/materialized-views.md` § Current limitations
("Backing-module pluggability"); this ticket is the design pass for it.

## Goal

`create materialized view mv using <module>(...) as <body>` places the backing
table in `<module>`; omitting the clause keeps today's memory default. All MV
semantics are preserved regardless of backing module: synchronous in-transaction
row-time maintenance, reads-own-writes within statement and transaction,
commit/rollback lockstep with the source write, MV-over-MV cascade, covering-
UNIQUE enforcement, refresh (data-only and shape-rebuild), and drop.

## Requirements / specification sketch

- Define a **backing-host capability** a module can advertise (the memory module
  implements it natively; a module that does not advertise it is rejected at
  create with a clear diagnostic). The capability must cover the duties the
  maintenance layer currently gets from `MemoryTableManager`:
  - privileged ordered op application (`upsert`, `delete-key`,
    `delete-by-prefix`, `replace-all` — the `MaintenanceOp` vocabulary) into a
    transactional pending layer, bypassing user-DML permission checks but
    keeping index bookkeeping;
  - **effective-change reporting**: each applied op returns the realized
    `BackingRowChange` (insert/update/delete with before-images) — the
    MV-over-MV cascade depends on this, so it is part of the contract, not a
    memory implementation detail;
  - base-layer replace for create-fill / refresh, with the `onDuplicateKey`
    "must be a set" diagnostic factory;
  - a connection that registers with the Database's coordinated
    commit/rollback (savepoint-stack replay included) and serves reads-own-writes
    point lookups for `_lookupCoveringConflicts`.
- `BackingConnectionCache` and `getBackingConnection` generalize from
  `MemoryTableConnection` to the capability's connection type.
- Decide and document the **cost contract**: the bounded-delta arms assume
  O(log n) keyed upsert/delete and (for `'prefix-delete'`) an ordered
  prefix-range delete. A module that cannot provide the prefix scan may need
  that arm gated to the floor for its backings.
- Declarative-schema / catalog round-trip: the `USING` clause must survive
  `ddl-generator` emission and schema diffing (today it round-trips textually
  but is semantically inert).
- Persistence interaction: a durable backing module changes the rehydrate
  story — the backing may already hold rows at re-register time. Define whether
  rehydrate trusts the stored backing (fast path) or refills from the body
  (current behavior), and how `bodyHash` staleness gates that choice. Coordinate
  with `store-mv-rehydrate-via-importcatalog` (prereq, in implement/), whose
  extracted `materializeView` helper is the same create/refresh core this
  ticket generalizes — design against the post-extraction shape.
- **Cross-module atomicity**: with the backing in module B and the source in
  module A, row-time maintenance writes span two modules inside one
  transaction. The Database's coordinated commit already spans registered
  connections, but atomic *durability* across two durable modules is the open
  2PC/saga question raised by `backlog/known/5-view-lens-mv-future-enhancements`
  § Federated multi-module write transactions. The plan must take a position:
  restrict durable backings to the source's module in v1, or accept the
  coordinated-commit guarantee and document the failure window.

## Use cases

- Lamina hosting an MV backing in its own `RowStore`, making covering
  structures durable and sync-visible instead of memory-resident.
- Store-module-backed MVs that survive reopen without a full body re-fill.
- Memory remains the default and the reference implementation; zero behavior
  change when `USING` is omitted.
