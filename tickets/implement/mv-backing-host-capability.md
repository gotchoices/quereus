description: Extract the MV backing-table privileged surface (maintenance ops, effective-change reporting, base replace, reads-own-writes scan, connection resolution) from MemoryTableManager into a module-neutral BackingHost capability on VirtualTableModule, with the memory module as the reference implementation. Pure refactor — zero behavior change; `USING` stays inert until the follow-on ticket.
files:
  - packages/quereus/src/vtab/backing-host.ts                        # NEW: BackingHost interface + MaintenanceOp/BackingRowChange moved here
  - packages/quereus/src/vtab/module.ts                              # add getBackingHost? to VirtualTableModule
  - packages/quereus/src/vtab/memory/module.ts                       # MemoryTableModule.getBackingHost (adapter over MemoryTableManager)
  - packages/quereus/src/vtab/memory/layer/manager.ts                # MaintenanceOp/BackingRowChange move OUT (import from backing-host)
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts   # getBackingManager → resolveBackingHost; replaceBaseLayer → host.replaceContents
  - packages/quereus/src/core/database-materialized-views.ts         # BackingConnectionCache + getBackingConnection generalized; arms call host.applyMaintenance; lookupCoveringConflicts via host.scanEffective
  - packages/quereus/src/core/database-external-changes.ts           # BackingRowChange import path
  - packages/quereus/src/core/database.ts                            # type import path
  - packages/quereus/src/core/database-internal.ts                   # type import path
  - packages/quereus/src/runtime/emit/dml-executor.ts                # type import path
  - packages/quereus/src/index.ts                                    # re-export BackingRowChange from the new home
  - docs/materialized-views.md                                       # Substrate + new "Backing-host capability" section
  - docs/module-authoring.md                                         # document the capability for module authors
----

# MV backing-host capability (extraction + memory reference implementation)

First of two steps toward backing-module pluggability (`USING <module>(...)` on
`CREATE MATERIALIZED VIEW`). This ticket is a **behavior-preserving refactor**:
define the capability a module must advertise to host an MV backing table, make
the memory module implement it, and route every engine consumer through the
capability instead of through `MemoryTableManager` directly. The follow-on
ticket (`mv-backing-using-module`) then makes `USING` semantic.

## The capability

New module-neutral file `packages/quereus/src/vtab/backing-host.ts`:

- **Move** `MaintenanceOp` and `BackingRowChange` here verbatim from
  `vtab/memory/layer/manager.ts` (they are the maintenance vocabulary, not a
  memory implementation detail — the MV-over-MV cascade and the external-change
  ingestion seam both consume `BackingRowChange`). Update all import sites
  (`database.ts`, `database-internal.ts`, `database-external-changes.ts`,
  `database-materialized-views.ts`, `dml-executor.ts`, `index.ts`, the
  incremental/vtab test suites); `manager.ts` imports them from the new home.
  No re-export shim from `manager.ts` — update importers instead (no
  backward-compat concern).

- **Define** the per-backing-table surface (one instance per live backing-table
  incarnation):

```ts
/** Scan request for the reads-own-writes effective-state scan. */
export interface BackingScanRequest {
	/** Leading-PK equality values to seek to (the ordered-PK contract);
	 *  omit for a full scan in PK order. */
	equalityPrefix?: SqlValue[];
	descending?: boolean;
}

/**
 * Privileged per-backing-table surface a backing-host module exposes.
 * Resolved via {@link VirtualTableModule.getBackingHost}; one instance per
 * live backing-table incarnation (a drop+recreate yields a NEW host whose
 * ownsConnection rejects the old incarnation's connections).
 */
export interface BackingHost {
	/** True when `conn` is a live connection to THIS backing-table incarnation. */
	ownsConnection(conn: VirtualTableConnection): boolean;
	/** Fresh connection for the current transaction. The caller registers it
	 *  with the Database so coordinated commit/rollback (savepoint-stack replay
	 *  included) covers its pending state in lockstep with the source write. */
	connect(): VirtualTableConnection;
	/** Privileged ordered op application into `conn`'s pending transaction
	 *  state: bypasses user-DML read-only enforcement, keeps secondary-index /
	 *  change-tracking bookkeeping, and returns the EFFECTIVE per-row changes
	 *  realized (the cascade contract — no-op ops yield nothing; `replace-all`
	 *  yields the minimal keyed diff). Later reads on `conn` (scanEffective,
	 *  point lookups) must observe the applied ops (reads-own-writes). */
	applyMaintenance(conn: VirtualTableConnection, ops: readonly MaintenanceOp[]): Promise<BackingRowChange[]>;
	/** Atomically replace the COMMITTED contents with `rows` (create-fill /
	 *  refresh). Throws `onDuplicateKey()` (or a generic CONSTRAINT) on a
	 *  duplicate PK among `rows`. Concurrent readers see pre- or post-swap
	 *  state, never partial. */
	replaceContents(rows: readonly Row[], onDuplicateKey?: () => QuereusError): Promise<void>;
	/** Reads-own-writes scan over `conn`'s effective state (pending transaction
	 *  state layered over committed), in PK order, honoring `equalityPrefix`
	 *  as a seek + early-terminate prefix range. */
	scanEffective(conn: VirtualTableConnection, req: BackingScanRequest): AsyncIterable<Row>;
}
```

- **Document the contract** in the same file (doc comments) and in
  `docs/materialized-views.md`:
  - *Cost*: PK-ordered storage with O(log n) keyed upsert/delete/point-lookup
    AND an ordered prefix-range scan are **required**. This is what keeps every
    bounded-delta arm (`delete-by-prefix` included) and the covering-UNIQUE
    prefix lookup module-agnostic. A module that cannot provide the ordered
    prefix scan must not advertise the capability. (Decided over per-arm
    gating: both real host candidates — Lamina RowStore, the LevelDB store —
    are ordered-KV, and per-module arm gating would fragment the maintenance
    planner for a hypothetical host.)
  - *Effective-change reporting* is part of the contract, not an optimization:
    the MV-over-MV cascade routes each returned `BackingRowChange` back through
    `maintainRowTime`, so over- or under-reporting corrupts consumer MVs.
  - *Transactionality*: `applyMaintenance` writes the connection's pending
    state; commit/rollback ride the registered `VirtualTableConnection`'s
    `begin/commit/rollback/savepoint` surface (already generic).
  - *Read-only to user DML*: a backing table must reject user DML (READONLY)
    while admitting `applyMaintenance`/`replaceContents`.

- **Module surface** (`vtab/module.ts`): add to `VirtualTableModule`:

```ts
/**
 * Optional. Returns the privileged backing-host surface for a table this
 * module owns, or undefined when the table is unknown to it. Presence of
 * the method is the capability (mirrors getMappingAdvertisements): a module
 * implementing it may host materialized-view backing tables. See
 * vtab/backing-host.ts for the semantic and cost contract.
 */
getBackingHost?(db: Database, schemaName: string, tableName: string): BackingHost | undefined;
```

## Memory reference implementation

`MemoryTableModule.getBackingHost` looks up the `MemoryTableManager` in
`this.tables` (same lowercased `schema.table` key as today's
`getBackingManager`) and returns an adapter:

- `ownsConnection(c)` — `c instanceof MemoryVirtualTableConnection &&
  c.getMemoryConnection().tableManager === manager` (preserves today's
  manager-identity check, which protects against adopting a connection from a
  dropped/recreated incarnation of the same name).
- `connect()` — `new MemoryVirtualTableConnection(qualifiedName, manager.connect())`.
- `applyMaintenance(c, ops)` — unwrap to `MemoryTableConnection`, delegate to
  `manager.applyMaintenanceToLayer` (which stays on the manager unchanged).
- `replaceContents` — `manager.replaceBaseLayer`.
- `scanEffective(c, req)` — unwrap; `manager.scanLayer(conn.pendingTransactionLayer
  ?? conn.readLayer, { indexName: 'primary', descending: !!req.descending,
  equalityPrefix: req.equalityPrefix })` — exactly the layer-start choice
  `lookupCoveringConflicts` makes today.

## Engine rewiring (all call sites, no semantic change)

- `materialized-view-helpers.ts`: `getBackingManager(backingSchema):
  MemoryTableManager` → `resolveBackingHost(backingSchema): BackingHost`
  (`requireVtabModule` + `module.getBackingHost`; INTERNAL error naming the
  table when the module lacks the method or doesn't know the table — same
  failure surface as today's "is not a memory table"). `materializeView`,
  `rebuildBacking`, `rebuildBackingTable` call `host.replaceContents`.
- `database-materialized-views.ts`:
  - `BackingConnectionCache` becomes `Map<string, VirtualTableConnection>`.
  - `getBackingConnection(host, qualifiedName, cache)` — scan
    `ctx.getConnectionsForTable(qualifiedName)` for `host.ownsConnection(c)`;
    on miss `host.connect()` + `ctx.registerConnection(...)` + cache. (The
    memory-specific `MemoryVirtualTableConnection` unwrap moves into the host.)
  - The four immediate arms + full rebuild call `host.applyMaintenance(conn, ops)`.
  - `lookupCoveringConflicts` iterates `host.scanEffective(conn, { equalityPrefix })`.
    The binary-collation soundness gate (`tryBuildCoveringPrefix`) stays
    engine-side, untouched — the host only executes the scan.
- Public export: `index.ts` re-exports `BackingRowChange` (and now also
  `MaintenanceOp`, since module authors need it) from `vtab/backing-host.js`.

## Edge cases & interactions

- **Reads-own-writes mid-statement** — `scanEffective` must read the pending
  transaction state, not just committed: a multi-row statement's later rows'
  covering-UNIQUE enforcement scans must observe earlier rows' backing writes.
  Pinned by the existing covering-enforcement logic tests; do not regress.
- **Incarnation identity** — after refresh's drop+recreate
  (`rebuildBackingTable`) the backing has a fresh manager; a stale
  same-name connection from the old incarnation must NOT be adopted.
  `ownsConnection`'s manager-identity check is load-bearing; the host adapter
  must capture the manager, not re-look it up by name.
- **Cold callers** — enforcement/eviction paths call `getBackingConnection`
  without a cache and must deterministically re-resolve the SAME connection the
  cached path holds (today's invariant; the generalized scan preserves it
  because `ownsConnection` is deterministic over the registered-connection set).
- **Effective-change exactness** — `replace-all` minimal diff, no-op
  `delete-key`/`delete-by-prefix` producing nothing, collation-correct key
  matching: all pinned by `test/vtab/maintenance-replace-all.spec.ts`,
  `maintenance-prefix-delete.spec.ts`, and
  `test/incremental/maintenance-equivalence.spec.ts` — these must pass
  unmodified except for import paths.
- **Type move fallout** — `BackingRowChange` is a public package export
  (external-change ingestion API); the export must keep the same exported name
  from `index.ts`. Check `quereus-sync`/adapter packages for direct deep
  imports of `vtab/memory/layer/manager.js` types (none expected, verify).
- **No new latching** — `applyMaintenanceToLayer`'s no-latch rationale (pending
  layer private to the connection, synchronous tree mutation) is per-host;
  document that hosts own their own concurrency discipline under the
  `VtabConcurrencyMode` they declare.

## TODO

- Create `vtab/backing-host.ts`: move `MaintenanceOp` + `BackingRowChange`, define `BackingScanRequest` + `BackingHost`, write the contract docs (cost, effective-change, transactionality, read-only).
- Add `getBackingHost?` to `VirtualTableModule` in `vtab/module.ts`.
- Implement the memory adapter on `MemoryTableModule` (manager captured by reference; `scanLayer` start-layer choice as specified).
- Replace `getBackingManager` with `resolveBackingHost` in `materialized-view-helpers.ts`; route `replaceBaseLayer` call sites through `host.replaceContents`.
- Generalize `BackingConnectionCache` / `getBackingConnection` / the five maintenance-apply call sites / `lookupCoveringConflicts` in `database-materialized-views.ts`.
- Update every `MaintenanceOp`/`BackingRowChange` import site and the `index.ts` re-export.
- Update `docs/materialized-views.md` (Substrate section: backing resolved via the backing-host capability; memory is the default + reference implementation) and `docs/module-authoring.md` (new capability section).
- `yarn build`, `yarn lint` (quereus), `yarn test` — all green with no test-expectation changes (import-path edits only).
