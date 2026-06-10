description: IMPLEMENTED — `USING <module>(...)` on CREATE MATERIALIZED VIEW is semantic. The backing table is created in the named backing-host module (memory default unchanged); the clause is carried on MaterializedViewSchema (`backingModuleName`/`backingModuleArgs`), emitted by the DDL generator, compared by the declarative differ as a separate field (module change ⇒ drop+recreate, bodyHash formula untouched), and honored on catalog import with pre-existing-backing handling. Build, lint, full test, and test:store all green.
files:
  - packages/quereus/src/schema/view.ts                              # backingModuleName/backingModuleArgs fields; normalizeBackingModule(Name) + canonicalBackingModuleArgs helpers (single source of truth)
  - packages/quereus/src/planner/building/materialized-view.ts       # allowlist replaced by capability gate (getBackingHost presence); normalization; canonical stored sql; threads fields
  - packages/quereus/src/planner/nodes/materialized-view-nodes.ts    # CreateMaterializedViewNode.backingModuleName/backingModuleArgs
  - packages/quereus/src/runtime/emit/materialized-view.ts           # create emitter feeds fields into MaterializeViewDefinition
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts   # buildBackingTableSchema(moduleName?, moduleArgs?) + defense-in-depth capability re-check; materializeView stamps; rebuildBackingTable passes mv's module
  - packages/quereus/src/schema/ddl-generator.ts                     # generateMaterializedViewDDL emits the clause (non-default only)
  - packages/quereus/src/schema/catalog.ts                           # CatalogMaterializedView.backingModuleName/backingModuleArgs
  - packages/quereus/src/schema/schema-differ.ts                     # module(+args) compared separately from bodyHash ⇒ drop+recreate
  - packages/quereus/src/schema/manager.ts                           # importMaterializedView honors the clause; pre-existing-backing drop/refill vs other-module per-entry error
  - packages/quereus/test/mv-backing-module.spec.ts                  # NEW: mem2 semantics matrix (13 tests)
  - packages/quereus/test/view-mv-ddl-persistence.spec.ts            # generator fixed point with clause; import coverage (5 new tests)
  - packages/quereus/test/declarative-equivalence.spec.ts            # differ module/args drift + no-drift spellings (3 new tests)
  - docs/materialized-views.md                                       # Substrate pluggable; using-clause DDL bullet; cross-module atomicity note; differ bullet; limitation entry removed
  - docs/module-authoring.md                                         # Backing Host section: USING selection + alterTable soft edge; inventory row updated
----

# Honor `USING <module>(...)` on CREATE MATERIALIZED VIEW — implemented

Second step of backing-module pluggability on top of the `BackingHost`
capability (`mv-backing-host-capability`, complete). `create materialized view
mv using <module>(...) as <body>` places the backing table in `<module>`;
omitting the clause keeps the memory default with zero behavior change.

## What was built

**Normalization (single source of truth, `schema/view.ts`)**:
`normalizeBackingModule(moduleName, moduleArgs)` — absent ⇒ `'memory'`, `mem`
aliased, lowercased; when the resolved module is `memory` with no args the
schema records NOTHING (`storedModuleName`/`storedModuleArgs` undefined), so
`using memory()` ≡ omitted: identical schema record, identical stored `sql`
(both builder and import stringify over the normalized identity), identical
generated DDL, no differ churn. Explicit `using memory(args)` with non-empty
args is the one default-module case that records and round-trips the clause.
Shared by the builder, `importMaterializedView`, and (name-normalize +
`canonicalBackingModuleArgs`) the differ.

**Builder gate** (`planner/building/materialized-view.ts`): the v1
`SUPPORTED_BACKING_MODULES` allowlist is gone. Missing module ⇒
`no virtual table module named '<m>'` (ERROR, sited at the view name); module
without `getBackingHost` ⇒ `module '<m>' cannot host a materialized-view
backing table (it does not implement the backing-host capability)`
(UNSUPPORTED, sited). Normalized identity threads node → create emitter →
`MaterializeViewDefinition`.

**Materialization**: `buildBackingTableSchema` takes `moduleName?`/`moduleArgs?`
(default memory), stamps `vtabModule`/`vtabModuleName`/`vtabArgs`/`vtabAuxData`
from the resolved registration, and re-checks the capability (defense-in-depth
for the import path). `materializeView` stamps the schema fields; refresh's
shape-rebuild (`rebuildBackingTable`) passes `mv.backingModuleName`/`Args` so a
rebuild cannot silently migrate the backing to memory. The rename-propagation
clone (`{...mv, ...overrides}`) carries the fields structurally.

**Round-trip**: `generateMaterializedViewDDL` lifts
`backingModuleName`/`backingModuleArgs` into the stmt (present only when
non-default). `CatalogMaterializedView` carries both; the differ compares
normalized declared vs normalized actual module plus a stable-key-order args
render, OR-ed with the existing bodyHash drift, into the same drop+recreate
path. **bodyHash formula is deliberately untouched** (no rebuild of
already-persisted MVs).

**Import** (`importMaterializedView`): honors the re-parsed clause (was:
silently memory). Pre-existing table at the backing name in the MV's OWN
module ⇒ dropped, then re-materialized (refill-from-body; the
adopt-without-refill fast path stays deferred to `store-mv-backing-host`).
Pre-existing table in a DIFFERENT module ⇒ per-entry CONSTRAINT error, table
and data untouched. Unknown/capability-less module ⇒ per-entry error via the
buildBackingTableSchema gate (importCatalog rethrows; the store's phase-3 loop
collects).

**Cross-module atomicity**: documented (not built) in
docs/materialized-views.md § Cross-module atomicity — coordinated commit, not
2PC; rehydrate refill self-heals divergence; no v1 restriction on module
combinations.

## Validation run

- `yarn build`, `yarn lint` — clean.
- `yarn test` — all workspaces green (quereus: 5647 passing).
- `yarn test:store` — green (5643 passing, 13 pending) — store-catalog
  round-trips unperturbed.

## Test coverage map (for the reviewer)

`test/mv-backing-module.spec.ts` (NEW — registers a second `MemoryTableModule`
as `mem2` and asserts backing residence via the module instances' `tables`
maps, so "lives in mem2, not memory" is verified structurally, not just by
`vtabModuleName`):
- builder diagnostics (unknown module; capability-less minimal module);
- `using memory()`/`using mem()` ≡ omitted (schema record, sql, generated DDL,
  bodyHash identity across spellings); explicit memory-with-args corner;
- create in mem2 → maintenance (I/U/D), data-only refresh, drop destroys in
  mem2; transaction rollback reverts the mem2 backing (incl. mid-txn
  reads-own-writes);
- refresh shape-rebuild (source ALTER against a `select *` body) preserves
  mem2; column-rename propagation renames the mem2 backing without perturbing
  the module and stays non-stale;
- create-fill failure ("must be a set") leaves no half-built backing in mem2;
- covering-UNIQUE in mem2: plain-duplicate reject, REPLACE eviction, and
  same-statement two-row REPLACE (reads-own-writes through the pending state);
- MV-over-MV across modules both directions; failing multi-row statement rolls
  back both backings in lockstep;
- bodyHash equality mem2 vs default + explicit formula assertion (no drift).

`test/view-mv-ddl-persistence.spec.ts`: generator fixed point with the clause
(mem2, mem2-with-args, memory-with-args); explicit-default normalizes away;
import honors `using mem2()` with maintenance live; unknown-module entry fails
per-entry with sources untouched; pre-existing same-module backing dropped +
refilled (stale rows replaced); pre-existing other-module table fails the
entry without dropping it; hand-written `using memory()` entry rehydrates to
the clause-free canonical record.

`test/declarative-equivalence.spec.ts`: module-only change ⇒ drop+recreate
both directions with rows preserved and bodyHash unperturbed, converging
re-diff; `using memory()`/`using mem()`/`using memory`/absent all no-drift
against a default-backed live MV; args-only change ⇒ drop+recreate, identical
args no-drift.

## Known gaps / honest notes

- **Registration-failure rollback in a named module is not directly tested.**
  The fill-failure rollback is asserted against mem2's table map; the
  `registerMaterializedView`-failure path (row-time eligibility gate) shares
  the same `sm.dropTable` cleanup and is covered only by existing
  default-module import tests (random() body). Low risk, but a reviewer could
  add an import-with-mem2 + ineligible-body case cheaply.
- **Host-without-`alterTable` rename staleness is documented, not tested** —
  mem2 (a MemoryTableModule) implements `alterTable`, and building a full
  custom backing-host module just to omit it was judged out of proportion. The
  UNSUPPORTED throw + mark-stale failure path is pre-existing code.
- **Behavioral note on import**: a pre-existing `_mv_<name>` table in the
  DEFAULT memory module is now also treated as "ours" (dropped + refilled) on
  import of a default-backed MV — previously this raised the backing-collision
  error. This follows the ticket's same-module rule uniformly; the
  other-module guard is what protects user data.
- **Pre-existing oddity left alone**: `mvModuleClauseToString` renders string
  arg values via `JSON.stringify` (double quotes → re-parsed as identifiers
  that map back to the same string). It round-trips and is fixed-point
  (tested), but is stylistically inconsistent with the table USING clause's
  single-quoted literal render. Untouched to avoid churning persisted DDL;
  flag if it should be unified.
- `canonicalBackingModuleArgs` renders number `1` and bigint `1n` identically;
  the parser only produces string/number literals for args, so this cannot
  misfire today.
