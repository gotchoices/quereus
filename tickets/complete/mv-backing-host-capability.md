description: COMPLETE — BackingHost capability extraction reviewed. The MV backing-table privileged surface (maintenance ops, effective-change reporting, base replace, reads-own-writes scan, connection resolution) moved from MemoryTableManager-direct access into a module-neutral capability on VirtualTableModule, memory module as reference implementation. Pure refactor verified behavior-preserving; review added direct capability-surface tests and fixed residual doc drift.
files:
  - packages/quereus/src/vtab/backing-host.ts                        # NEW: MaintenanceOp/BackingRowChange + BackingScanRequest/BackingHost + contract docs
  - packages/quereus/src/vtab/module.ts                              # getBackingHost? on VirtualTableModule
  - packages/quereus/src/vtab/memory/module.ts                       # MemoryBackingHost adapter + MemoryTableModule.getBackingHost
  - packages/quereus/src/vtab/memory/layer/manager.ts                # types now imported from backing-host
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts   # resolveBackingHost; replaceContents at 3 fill sites
  - packages/quereus/src/core/database-materialized-views.ts         # generalized cache/connection resolution; 5 apply sites + lookupCoveringConflicts via host
  - packages/quereus/src/runtime/emit/materialized-view.ts           # stale replaceBaseLayer comment fixed (review)
  - packages/quereus/test/vtab/backing-host.spec.ts                  # NEW (review): direct capability-surface contract tests
  - docs/materialized-views.md                                       # backing-host section (implement) + row-time/cascade drift fixed (review)
  - docs/incremental-maintenance.md                                  # cascade-flow lines routed through the host (review)
  - docs/module-authoring.md                                         # "4. Backing Host" capability section + inventory rows
----

# MV backing-host capability — reviewed and complete

First of two steps toward `USING <module>(...)` backing pluggability
(follow-on `mv-backing-using-module` in implement/; `store-mv-backing-host`
in plan/). Behavior-preserving extraction: `BackingHost`
(`vtab/backing-host.ts`) is the per-backing-table privileged surface —
`ownsConnection` / `connect` / `applyMaintenance` / `replaceContents` /
`scanEffective` — resolved via the optional
`VirtualTableModule.getBackingHost(db, schemaName, tableName)` (method
presence is the capability). `MemoryBackingHost` adapts one
`MemoryTableManager`, captured by reference (incarnation pinning). Every
engine consumer (five maintenance-apply sites, three create/refresh fill
sites, the covering-UNIQUE enforcement scan, connection resolution +
per-statement `BackingConnectionCache`) routes through the capability;
`MaintenanceOp`/`BackingRowChange` moved to the module-neutral file and
`index.ts` re-exports `BackingRowChange`, `MaintenanceOp`, `BackingHost`,
`BackingScanRequest`. `USING` stays inert.

## Review findings

**Reviewed the full implement diff (`d5e9bdcd`) file-by-file against the
original ticket spec, then verified each load-bearing equivalence in the
current code.**

### Checked — no issues found

- **Reads-own-writes start layer**: `MemoryBackingHost.scanEffective` uses
  `pendingTransactionLayer ?? readLayer` — byte-for-byte the choice removed
  from `lookupCoveringConflicts`; `pendingTransactionLayer` is
  `TransactionLayer | null` so `??` behaves identically to the old inline code.
- **`equalityPrefix: undefined` consolidation**: `scan-layer.ts`,
  `plan-filter.ts`, and the early-termination path all gate on
  `if (plan.equalityPrefix)`, so the single `scanEffective(conn,
  { equalityPrefix })` call preserves both prior ScanPlan branches. Neither the
  old nor the new scan passes `equalityPrefixCollations` (BINARY compare),
  matching the engine-side `tryBuildCoveringPrefix` binary-collation gate,
  which is untouched.
- **Incarnation identity**: the host captures the manager by reference;
  `getBackingHost` re-looks up `module.tables` per call; every engine use site
  resolves the host fresh (grep-verified — nothing stores a `BackingHost` in a
  field or cache; only connections are cached, per-statement). Refresh's
  drop+recreate therefore always yields the new incarnation's host, and
  `ownsConnection` (instanceof + manager-identity, verbatim from the old
  inline check) rejects stale connections. Now pinned by a direct test.
- **Connection naming substitution**: `host.connect()` names the wrapper
  `${manager.schemaName}.${manager.tableName}` where the old code used the
  caller-supplied `${plan.backingSchema}.${plan.backingTableName}`. Both
  originate from the same schema objects, and
  `Database.getConnectionsForTable` lowercases both sides and also matches the
  bare table name — so resolution is unaffected even under case drift.
- **Cache value semantics**: `BackingConnectionCache` values changed from the
  inner `MemoryTableConnection` to the wrapper `VirtualTableConnection`; the
  only consumers are `getBackingConnection` itself and the host methods (which
  unwrap), and the cold (cache-less) paths re-resolve via the same
  deterministic `ownsConnection` scan the cached path used. dml-executor /
  external-changes only construct and thread the Map.
- **Failure surface**: `resolveBackingHost` throws sited INTERNAL both when
  the module lacks the capability and when it doesn't know the table — same
  surface as the old "not a memory table" / "manager not found" pair.
- **Type-move fallout**: no deep imports of `vtab/memory/layer/manager.js`
  types anywhere outside `packages/quereus` (repo-wide grep); `index.ts` keeps
  `BackingRowChange` exported under the same name. `backing-host.ts`'s imports
  are all type-only — no runtime import cycle (memory/module → backing-host →
  memory/types is types-only and acyclic).
- **Isolation/store wrappers**: neither declares `getBackingHost`, matching
  the new module-authoring inventory row ("—"); backing tables are
  engine-created on the memory module only today, so no wrapped-module path
  exists yet (the `store-mv-backing-host` plan ticket owns that future).
- **Test-local resolvers** in the two layer-mechanics suites reproduce the old
  `getBackingManager` exactly; all test bodies/expectations unmodified.
- **`runtime/utils.ts` memory-specific connection injection** still references
  `MemoryVirtualTableConnection` directly — inspected and confirmed out of
  scope: it is the pre-existing *general scan* connection-reuse path (gated on
  `vtabModuleName === 'memory'`), not part of the MV privileged surface this
  ticket extracted.

### Found and fixed in this pass (minor)

- **Doc drift in `docs/materialized-views.md` row-time sections** — the
  implement pass updated the Substrate/refresh/new-capability sections but
  three passages still described the engine seam in memory-direct terms:
  the MV-over-MV cascade attributed effective-change reporting to
  `applyMaintenanceToLayer` directly; `BackingConnectionCache` was documented
  as `Map<backingBase, MemoryTableConnection>`; and the "backing write is
  routed through…" paragraph named `MemoryTableConnection` /
  `MemoryTableManager.applyMaintenanceToLayer` / `validateMutationPermissions`
  as the engine path. All three now lead with the `BackingHost` surface with
  memory specifics as parentheticals.
- **`docs/incremental-maintenance.md` cascade-flow lines** (`applyMaintenancePlan
  → applyMaintenanceToLayer → …`) now route through the backing host's
  `applyMaintenance`.
- **Stale comment** in `runtime/emit/materialized-view.ts` (refresh shape
  check) said "`replaceBaseLayer`-ing" — now "`replaceContents`-ing".
- **Missing direct capability-surface tests** — the implement handoff flagged
  this gap explicitly. Added `test/vtab/backing-host.spec.ts` (8 tests) pinning
  the contract a second host will be built against: capability resolution
  (owned table vs unknown), `ownsConnection` cross-table rejection,
  drop+recreate incarnation pinning (new host rejects the stale connection,
  old host stays pinned by reference), INTERNAL on driving `applyMaintenance`/
  `scanEffective` with a foreign connection, reads-own-writes (pending visible
  on the writing connection, invisible to a fresh one) with exact effective-
  change reporting, `equalityPrefix` ranging + `descending`, `replaceContents`
  committed replacement, and the `onDuplicateKey` diagnostic with no torn
  state after a failed replace.

### Accepted judgement calls (no action)

- `backing-host.ts` imports `BTreeKeyForPrimary` (a trivial
  `SqlValue | SqlValue[]` alias) type-only from `vtab/memory/types.js` for
  verbatim type identity of the moved `delete-key` op. Hoisting the alias
  would buy stricter module-neutrality at the cost of churning memory-module
  code; zero behavioral impact either way. The `store-mv-backing-host` work
  can hoist it if a second host makes that worthwhile.
- `index.ts` exports two types beyond the spec (`BackingHost`,
  `BackingScanRequest`) — required for module authors to implement the
  capability; correct deviation.
- `yarn test:store` not run — per AGENTS.md it is reserved for store-specific
  diagnosis/release; this refactor touches no store code path (backing tables
  are always memory-module today).

### Validation (review pass)

- `yarn build` (full monorepo) — green; quereus package rebuilt again after
  the comment fix — green.
- `yarn lint` (quereus, src + test) — green.
- `yarn test` (all workspaces) — green: quereus **5624 passing
  (5616 + 8 new) / 9 pending / 0 failing**; all other workspaces pass. No
  pre-existing failures observed.

### Findings disposed as new tickets

None — no major findings. All findings were minor and fixed inline above.
