description: Make `USING <module>(...)` on CREATE MATERIALIZED VIEW semantic — the backing table is created in the named backing-host module (memory default unchanged), with the clause carried on MaterializedViewSchema, emitted by the DDL generator, compared by the declarative differ (module change ⇒ drop+recreate), and honored on catalog import.
prereq: mv-backing-host-capability
files:
  - packages/quereus/src/planner/building/materialized-view.ts       # replace v1 allowlist with capability check; thread moduleName/moduleArgs
  - packages/quereus/src/planner/nodes/materialized-view-nodes.ts    # CreateMaterializedViewNode carries moduleName/moduleArgs
  - packages/quereus/src/runtime/emit/materialized-view.ts           # create emitter feeds them into MaterializeViewDefinition
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts   # buildBackingTableSchema parameterized by module; refresh/rename rebuilds preserve it
  - packages/quereus/src/schema/view.ts                              # MaterializedViewSchema.backingModuleName/backingModuleArgs
  - packages/quereus/src/schema/ddl-generator.ts                     # generateMaterializedViewDDL emits the using clause when non-memory
  - packages/quereus/src/schema/schema-differ.ts                     # module identity compared separately from bodyHash
  - packages/quereus/src/schema/manager.ts                           # importMaterializedView honors the clause; pre-existing-backing handling
  - packages/quereus/test/view-mv-ddl-persistence.spec.ts            # round-trip + import coverage
  - docs/materialized-views.md                                       # Substrate, Current limitations (drop the pluggability entry), atomicity note
----

# Honor `USING <module>(...)` on CREATE MATERIALIZED VIEW

Second step of backing-module pluggability, on top of the `BackingHost`
capability (`mv-backing-host-capability`). `create materialized view mv using
<module>(...) as <body>` places the backing table in `<module>`; omitting the
clause keeps the memory default with **zero behavior change**. All MV semantics
hold regardless of module: row-time maintenance, reads-own-writes,
commit/rollback lockstep, MV-over-MV cascade, covering-UNIQUE enforcement,
refresh (data-only and shape-rebuild), rename propagation, and drop.

## Builder (create gate)

Replace the `SUPPORTED_BACKING_MODULES` allowlist in
`planner/building/materialized-view.ts`:

- Normalize the name: absent ⇒ `'memory'`; keep the `'mem'` alias mapping to
  `'memory'`.
- Resolve via `schemaManager.getModule(name)`. Missing module ⇒ clear
  diagnostic (`no virtual table module named '<m>'`, sited at the view name).
- Module present but no `getBackingHost` method ⇒ clear diagnostic:
  `module '<m>' cannot host a materialized-view backing table (it does not
  implement the backing-host capability)` — `UNSUPPORTED`, sited.
- Thread the **normalized** `moduleName` and `moduleArgs` onto
  `CreateMaterializedViewNode`, the create emitter, and
  `MaterializeViewDefinition`.

**Normalization decision:** when the resolved module is `'memory'` (explicit
`using memory()`/`mem()` with no args), store NOTHING on the schema — explicit
default ≡ omitted. This keeps existing persisted catalogs byte-identical, keeps
the DDL generator canonical, and keeps the differ from churning on
`using mem()` vs absent. Explicit `using memory(...)` with non-empty args is
the one case that still records args (and round-trips with the clause).

## Schema + materialization

- `MaterializedViewSchema` gains `backingModuleName?: string` (absent ⇒
  `'memory'`) and `backingModuleArgs?: Readonly<Record<string, SqlValue>>`.
- `buildBackingTableSchema(db, schemaName, backingTableName, shape, moduleName?,
  moduleArgs?)` resolves the named module (default `'memory'`) and stamps
  `vtabModule` / `vtabModuleName` / `vtabArgs` / `vtabAuxData` from it. The
  capability re-check here is defense-in-depth (import path reaches it without
  the builder); throw the same UNSUPPORTED diagnostic.
- `materializeView` stamps the new schema fields from the definition.
- **Refresh shape-rebuild (`rebuildBackingTable`) and the rename-propagation
  backing rebuild must preserve the module** — they call
  `buildBackingTableSchema` and must pass `mv.backingModuleName` /
  `backingModuleArgs`, not fall back to memory.

## Round-trip surfaces

- `generateMaterializedViewDDL` emits the `using` clause from
  `backingModuleName`/`backingModuleArgs` when present (i.e. only when
  non-default — see normalization). `createMaterializedViewToString` already
  renders the clause from the AST.
- **bodyHash is deliberately NOT extended** — folding the module into
  `viewDefinitionToCanonicalString` would change the hash formula and spuriously
  rebuild every already-persisted MV on its next diff. Instead the differ
  compares module identity as a separate field: normalized declared module
  (`stmt.moduleName ?? 'memory'`, `'mem'` → `'memory'`) vs normalized actual
  (`mv.backingModuleName ?? 'memory'`), plus a canonical-args comparison
  (stable-key-order render). Mismatch ⇒ the same drop+recreate path a bodyHash
  drift takes.
- `importMaterializedView` (schema/manager.ts) honors the re-parsed clause —
  it currently ignores `stmt.moduleName` and silently materializes into memory
  (accepted in the prereq's review only because the generator never emitted the
  clause; that premise ends here). Unknown / capability-less module at import ⇒
  the error surfaces as a per-entry rehydration error (the store's phase-3 loop
  already collects these).

## Import-time pre-existing backing

A durable backing-host module may have rehydrated its own `_mv_<name>` table
(phase 1) before the MV catalog entry imports (phase 3), so
`createBackingTable`'s "already exists" check would reject the import. In
`importMaterializedView` only (the create emitter keeps today's collision
error):

- A pre-existing table at the backing name whose `vtabModuleName` equals the
  MV's declared backing module is treated as the rehydrated backing: **drop it,
  then materialize normally** (refill-from-body — current semantics, correct
  for any module). The *adopt-without-refill* fast path is designed and
  deferred to `store-mv-backing-host` (plan).
- A pre-existing table in a DIFFERENT module is not ours — fail the entry with
  a clear per-entry error rather than dropping user data.

## Cross-module atomicity (position, documented not built)

With backing in module B and sources in module A, one transaction spans two
modules. The Database's coordinated commit covers both connections, but it is
not 2PC: a crash between two durable modules' commits can leave them divergent.
**Position: accept the coordinated-commit guarantee and document the window**
(docs/materialized-views.md). Mitigation: rehydrate refills the backing from
the body (above), so any divergence self-heals at next open; the future
adopt fast path is gated to same-module sources for exactly this reason.
No v1 restriction on module combinations.

## Edge cases & interactions

- **`using memory()` ≡ omitted** — identical schema record, identical generated
  DDL, no differ churn between the two spellings (the normalization decision).
- **Module change via declarative schema** — declared `using mem2()` against a
  live memory-backed MV ⇒ drop+recreate into mem2; reverse direction too; body
  unchanged so bodyHash matches — only the module comparison fires.
- **Refresh preserves module** — both refresh paths (data-only
  `rebuildBacking`; shape-rebuild `rebuildBackingTable`) keep the backing in
  its module. A shape-rebuild that forgets the module would silently migrate
  the backing to memory — test this explicitly.
- **Rename propagation** — `renameShiftedBackingColumns` routes through
  `module.alterTable`; a host module without `alterTable` throws UNSUPPORTED
  and the existing failure path marks the MV stale (acceptable; document on the
  capability). Table/column rename propagation must not perturb
  `backingModuleName` on the rewritten schema clone.
- **MV-over-MV across modules** — mv2 (memory) over mv1 (mem2): the cascade
  resolves each level's host independently; a write to the source must flow
  through both backings in one transaction. Cover in tests.
- **Covering-UNIQUE enforcement in a non-default module** — the prefix-scan
  fast path and the full-scan fallback both route through `scanEffective`;
  REPLACE eviction and same-statement reads-own-writes must hold with the
  backing in mem2.
- **Drop / create-rollback in the named module** — `sm.dropTable` routes
  `module.destroy`; the create-fill failure and registration-failure rollback
  paths must drop the half-built backing from the NAMED module.
- **Import errors** — catalog entry with `using nosuch()` ⇒ per-entry error,
  source rows untouched, no half-built backing (extend the existing
  rollback-shape import tests).
- **`bodyHash` stability** — assert an existing memory-backed MV's hash is
  unchanged by this ticket (no formula drift).

## Tests

Register a second `MemoryTableModule` instance as `mem2` to get a genuine
non-default backing-host module with full semantics — no new test
infrastructure:

- create `using mem2()` → backing lives in mem2's table map (assert via module
  instance), maintenance + enforcement + refresh + drop all green.
- builder diagnostics: unknown module; module without the capability (register
  a minimal vtab module lacking `getBackingHost`).
- `generateMaterializedViewDDL` fixed point with the clause; absent for
  memory/default.
- differ: module-only change schedules drop+recreate; `using mem()` vs absent
  is no-drift.
- `importCatalog` honors `using mem2()`; unknown-module entry fails per-entry;
  pre-existing same-module backing is replaced; pre-existing other-module
  table fails the entry.
- MV-over-MV chain spanning memory and mem2, including rollback of a failing
  statement across both backings.

## TODO

- Builder: capability-based validation + normalization; thread moduleName/moduleArgs through node → emitter → `MaterializeViewDefinition`.
- Schema: `backingModuleName`/`backingModuleArgs` on `MaterializedViewSchema`; stamp in `materializeView`.
- `buildBackingTableSchema` parameterized by module; refresh + rename rebuild paths pass the MV's module.
- DDL generator emits the clause (non-default only); drop the "deliberately omits" comment.
- Differ: separate module(+args) comparison ⇒ drop+recreate on mismatch.
- `importMaterializedView`: honor the clause; pre-existing-backing drop/refill vs other-module error.
- Docs: `docs/materialized-views.md` — Substrate (module-pluggable backing), remove the "Backing-module pluggability" limitation entry, add the cross-module atomicity note; `docs/module-authoring.md` cross-reference.
- Tests per the matrix above; `yarn build`, `yarn lint`, `yarn test` green; run `yarn test:store` once to confirm store-catalog round-trips are unperturbed.
