description: Review the BackingHost capability extraction — the MV backing-table privileged surface (maintenance ops, effective-change reporting, base replace, reads-own-writes scan, connection resolution) moved from MemoryTableManager-direct access into a module-neutral capability on VirtualTableModule, with the memory module as reference implementation. Pure refactor — zero intended behavior change; `USING` stays inert.
files:
  - packages/quereus/src/vtab/backing-host.ts                        # NEW: MaintenanceOp/BackingRowChange moved here + BackingScanRequest/BackingHost + contract docs
  - packages/quereus/src/vtab/module.ts                              # getBackingHost? added to VirtualTableModule
  - packages/quereus/src/vtab/memory/module.ts                       # MemoryBackingHost adapter + MemoryTableModule.getBackingHost
  - packages/quereus/src/vtab/memory/layer/manager.ts                # MaintenanceOp/BackingRowChange now imported from backing-host
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts   # getBackingManager → resolveBackingHost(db, schema); replaceContents at 3 fill sites
  - packages/quereus/src/core/database-materialized-views.ts         # BackingConnectionCache/getBackingConnection generalized; 5 apply sites + lookupCoveringConflicts via host
  - packages/quereus/src/core/database-external-changes.ts           # import path
  - packages/quereus/src/core/database.ts                            # import path
  - packages/quereus/src/core/database-internal.ts                   # import path
  - packages/quereus/src/runtime/emit/dml-executor.ts                # import path
  - packages/quereus/src/index.ts                                    # re-exports BackingRowChange, MaintenanceOp, BackingHost, BackingScanRequest
  - packages/quereus/test/vtab/maintenance-prefix-delete.spec.ts     # test-local manager resolver (see deviations)
  - packages/quereus/test/vtab/maintenance-replace-all.spec.ts       # test-local manager resolver (see deviations)
  - docs/materialized-views.md                                       # Substrate bullet + new "Backing-host capability" section; replaceBaseLayer mentions → replaceContents
  - docs/module-authoring.md                                         # "4. Backing Host" capability section + signaling-styles/surface-inventory rows
----

# Review: MV backing-host capability (extraction + memory reference implementation)

First of two steps toward `USING <module>(...)` backing pluggability. This was a
**behavior-preserving refactor**: define `BackingHost` (the per-backing-table
privileged surface), implement it on the memory module, and route every engine
consumer through the capability instead of through `MemoryTableManager` directly.
The follow-on `mv-backing-using-module` (already in implement/, prereq'd on this)
makes `USING` semantic; `store-mv-backing-host` (plan/) adds a second host.

## What landed

- **`vtab/backing-host.ts` (new).** `MaintenanceOp` + `BackingRowChange` moved
  verbatim from `vtab/memory/layer/manager.ts` (manager.ts now imports them; no
  re-export shim). `BackingScanRequest` + `BackingHost` defined per spec, with
  the contract (cost: ordered-PK + O(log n) keyed ops + ordered prefix scan
  required, no per-arm gating; effective-change exactness; transactionality via
  the registered connection; READONLY to user DML; per-host concurrency
  discipline) in the file-header doc comment.
- **`VirtualTableModule.getBackingHost?(db, schemaName, tableName)`** — presence
  is the capability (mirrors `getMappingAdvertisements`).
- **`MemoryBackingHost`** (in `vtab/memory/module.ts`): captures the
  `MemoryTableManager` **by reference** (incarnation pinning). `ownsConnection` =
  `instanceof MemoryVirtualTableConnection && getMemoryConnection().tableManager
  === manager` (today's identity check, verbatim). `applyMaintenance` →
  `applyMaintenanceToLayer` (unchanged on the manager); `replaceContents` →
  `replaceBaseLayer`; `scanEffective` → `scanLayer(pendingTransactionLayer ??
  readLayer, { indexName: 'primary', descending, equalityPrefix })` — exactly the
  start-layer choice `lookupCoveringConflicts` made inline before. `unwrap`
  throws INTERNAL on a foreign/stale-incarnation connection.
- **Engine rewiring.** `resolveBackingHost(db, backingSchema)` replaces
  `getBackingManager` (INTERNAL when the module lacks the method or doesn't know
  the table — same failure surface). The three fill sites (`materializeView`,
  `rebuildBacking`, `rebuildBackingTable`) call `host.replaceContents`. In
  `database-materialized-views.ts`: `BackingConnectionCache` is now
  `Map<string, VirtualTableConnection>`; `getBackingConnection(host, name, cache?)`
  scans `getConnectionsForTable` for `host.ownsConnection(c)`, else
  `host.connect()` + `registerConnection` + cache (the memory unwrap moved into
  the host); the five maintenance-apply sites call `host.applyMaintenance`;
  `lookupCoveringConflicts` iterates `host.scanEffective(conn, { equalityPrefix })`
  with the binary-collation soundness gate (`tryBuildCoveringPrefix`) untouched
  engine-side. A private `backingHost()` helper supplies the `db` arg via the
  pre-existing `this.ctx as unknown as Database` cast (same as
  `buildMaintenancePlan`).
- **Import-path updates** in `database.ts`, `database-internal.ts`,
  `database-external-changes.ts`, `dml-executor.ts`; `index.ts` re-exports from
  the new home.
- **Docs**: `materialized-views.md` Substrate bullet + a new "Backing-host
  capability" section (surface table + contract highlights);
  `module-authoring.md` gets "### 4. Backing Host" under Module Capability APIs
  plus signaling-styles and surface-inventory rows.

## Validation performed

- `yarn build` (full monorepo, sequential) — green.
- `yarn lint` (quereus, covers `src/**` and `test/**`) — green.
- `yarn test` (all workspaces, memory-backed) — green: **5616 passing / 9
  pending / 0 failing** in quereus; all other workspaces pass. No test
  *expectations* changed anywhere.
- Verified `scan-layer.ts` treats `equalityPrefix: undefined` identically to an
  absent field (`if (plan.equalityPrefix)`), so the consolidated
  `scanEffective(conn, { equalityPrefix })` call preserves both prior ScanPlan
  branches; the prefix is never an empty array (k = uc.columns.length ≥ 1).
- Grep-verified no deep imports of `vtab/memory/layer/manager.js` types outside
  `packages/quereus` (quereus-sync/adapters import `BackingRowChange` only via
  the package root, which still exports it under the same name).

## Deviations from the ticket spec (flag for review)

- **Tests needed more than import-path edits.** The ticket predicted the two
  layer-mechanics suites (`maintenance-prefix-delete.spec.ts`,
  `maintenance-replace-all.spec.ts`) would change "import paths only", but they
  imported the now-deleted `getBackingManager` *function* to reach the raw
  `MemoryTableManager`. Each spec got a ~10-line test-local resolver of the same
  name (module lookup via `schema.vtabModule as MemoryTableModule` →
  `tables.get(...)`); **all test bodies and expectations are unmodified**.
- **`index.ts` exports two extra types**: `BackingHost` and `BackingScanRequest`
  in addition to the mandated `BackingRowChange` + `MaintenanceOp` — module
  authors cannot implement the capability without naming them.
- **`backing-host.ts` imports `BTreeKeyForPrimary` from `vtab/memory/types.js`**
  (the `delete-key` op's key type). It is a trivial value alias
  (`SqlValue | SqlValue[]`); kept as a type-only import for verbatim type
  identity rather than re-declaring. A reviewer may prefer hoisting the alias
  out of memory/types for stricter module-neutrality — judgement call, zero
  behavioral impact.

## Review focus — the load-bearing equivalences

- **Reads-own-writes mid-statement**: `scanEffective` reads
  `pendingTransactionLayer ?? readLayer`; pinned by the existing
  covering-enforcement logic tests (multi-row statement, later rows observe
  earlier rows' backing writes). Confirm the adapter's start-layer choice is
  byte-for-byte the one removed from `lookupCoveringConflicts`.
- **Incarnation identity**: the host captures the manager by reference, and
  `backingHost()` re-resolves the host *fresh at each apply/lookup site* (a map
  lookup), so refresh's drop+recreate (`rebuildBackingTable`) gets the new
  manager while `ownsConnection` rejects the old incarnation's registered
  connections. Worth adversarial scrutiny: nothing caches a `BackingHost`
  across statements (only connections are cached, per-statement).
- **Cold-caller determinism**: enforcement/eviction paths call
  `getBackingConnection` without a cache; `ownsConnection` over the registered
  connection set must re-resolve the SAME connection the cached path holds
  (deterministic — same predicate as the old `instanceof` + manager-identity
  scan).
- **Effective-change exactness**: `replace-all` minimal diff, no-op deletes
  producing nothing, collation-correct key matching — pinned by
  `test/vtab/maintenance-replace-all.spec.ts`,
  `maintenance-prefix-delete.spec.ts`, and
  `test/incremental/maintenance-equivalence.spec.ts`, all passing with
  unmodified expectations.
- **Connection naming**: `MemoryBackingHost.connect()` builds the qualified name
  from `manager.schemaName`/`manager.tableName` where the old code used the
  caller-supplied `${plan.backingSchema}.${plan.backingTableName}`. These are
  the same names modulo case (both original-case from the schema), and
  `getConnectionsForTable` matches lowercased — but it is a subtle substitution
  worth a second pair of eyes.

## Known gaps

- `yarn test:store` (LevelDB-backed logic-test rerun) was **not** run — per
  AGENTS.md it is reserved for store-specific diagnosis/release, and this
  refactor touches no store code path (backing tables are always memory-module).
  A reviewer wanting belt-and-braces coverage could run it.
- No new tests were added: the ticket scoped this as a pure refactor pinned by
  the existing suites. The capability surface itself (e.g. `unwrap`'s INTERNAL
  on a foreign connection, `getBackingHost` returning undefined for an unknown
  table) has no direct unit test — it is exercised only implicitly through the
  MV suites. The follow-on `mv-backing-using-module` is the natural place to
  add direct capability-surface tests if desired.
