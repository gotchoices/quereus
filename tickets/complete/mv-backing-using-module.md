description: COMPLETE — `USING <module>(...)` on CREATE MATERIALIZED VIEW is semantic; reviewed. Backing table is created in the named backing-host module (memory default unchanged); identity carried on MaterializedViewSchema, emitted by the DDL generator, compared by the differ as a separate field (drop+recreate; bodyHash formula untouched), honored on catalog import with pre-existing-backing handling. Review pass fixed stale docs/schema.md passages, a debug-output omission, and added the one missing rollback test.
files:
  - packages/quereus/src/schema/view.ts                              # normalizeBackingModule(Name) + canonicalBackingModuleArgs (single source of truth)
  - packages/quereus/src/planner/building/materialized-view.ts       # capability gate (getBackingHost presence) replaces v1 allowlist
  - packages/quereus/src/planner/nodes/materialized-view-nodes.ts    # backingModuleName/Args on the node (+ both in getLogicalAttributes — review fix)
  - packages/quereus/src/runtime/emit/materialized-view.ts           # create emitter threads fields into MaterializeViewDefinition
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts   # buildBackingTableSchema(moduleName?, moduleArgs?) + defense-in-depth re-check; rebuildBackingTable preserves the module
  - packages/quereus/src/schema/ddl-generator.ts                     # generateMaterializedViewDDL emits the clause (non-default only)
  - packages/quereus/src/schema/catalog.ts                           # CatalogMaterializedView.backingModuleName/Args
  - packages/quereus/src/schema/schema-differ.ts                     # module(+args) compared separately from bodyHash ⇒ drop+recreate
  - packages/quereus/src/schema/manager.ts                           # importMaterializedView honors the clause; same-module pre-existing backing drop/refill vs other-module per-entry error
  - packages/quereus/test/mv-backing-module.spec.ts                  # mem2 semantics matrix (13 tests)
  - packages/quereus/test/view-mv-ddl-persistence.spec.ts            # fixed point + import coverage (6 tests incl. review-added named-module rollback)
  - packages/quereus/test/declarative-equivalence.spec.ts            # differ drift / no-drift spellings (3 tests)
  - docs/materialized-views.md                                       # pluggable substrate; using-clause bullet; cross-module atomicity; differ bullet
  - docs/module-authoring.md                                         # Backing Host: USING selection + alterTable soft edge
  - docs/schema.md                                                   # review fixes: import bullet, generator paragraph, differ section (were stale)
----

# Honor `USING <module>(...)` on CREATE MATERIALIZED VIEW — complete

Second step of backing-module pluggability on top of the `BackingHost`
capability (`mv-backing-host-capability`). `create materialized view mv using
<module>(...) as <body>` places the backing table in `<module>`; omitting the
clause keeps the memory default with zero behavior change.

## What was built (implement stage)

- **Normalization** (`schema/view.ts`, single source of truth):
  `normalizeBackingModule` — absent ⇒ `'memory'`, `mem` aliased, lowercased;
  memory-with-no-args records NOTHING, so `using memory()` ≡ omitted (one
  schema record, one stored `sql`, one generated DDL, no differ churn).
  Explicit `using memory(args)` with non-empty args is the one default-module
  case that records the clause.
- **Builder gate**: v1 allowlist replaced by capability presence
  (`getBackingHost`); unknown module ⇒ sited ERROR, capability-less ⇒ sited
  UNSUPPORTED. `buildBackingTableSchema` re-checks as defense-in-depth for the
  import path.
- **Materialization**: backing `TableSchema` stamped with the resolved
  module/args/auxData; `rebuildBackingTable` (refresh shape-rebuild) passes the
  MV's own module so a rebuild cannot silently migrate the backing to memory;
  the rename-propagation clone carries the fields structurally.
- **Round-trip**: `generateMaterializedViewDDL` emits the clause when
  non-default; `CatalogMaterializedView` carries both fields; the differ
  compares normalized module + stable-key-order args render OR-ed with the
  existing bodyHash drift into the same drop+recreate path — **bodyHash
  formula deliberately untouched** (no rebuild of already-persisted MVs).
- **Import** (`importMaterializedView`): honors the re-parsed clause.
  Pre-existing `_mv_<name>` table in the MV's OWN module ⇒ dropped + refilled
  from the body (adopt-without-refill deferred to `store-mv-backing-host`);
  in a DIFFERENT module ⇒ per-entry CONSTRAINT error, table untouched.
- **Cross-module atomicity**: documented (coordinated commit ≠ 2PC; rehydrate
  refill self-heals divergence; no v1 module-combination restriction).

## Review findings

**Process**: read the full implement diff (`031de70d`) with fresh eyes before
the handoff; traced every `MaterializedViewSchema` construction/clone site
(materializeView, `applyMaterializedViewRewrite`'s spread clone, the tag
setters' spread, rebuildBackingTable, plan node → emitter threading); verified
parser behavior (`using m()` parses args to `undefined`; positional args key
`"0","1",…` — comparison-stable), module registration/lookup case handling
(both lowercase), the differ's recreate emission (declared stmt carries the
clause — test-asserted), and the stringifier's clause render. Ran
`yarn build`, `yarn lint`, `yarn test` — all green (quereus **5648 passing**,
9 pending, including the review-added test).

**Correctness — no defects found.** Specific adversarial checks that came back
clean:

- The `mem` alias cannot shadow a real module today (`'mem'` is registered
  nowhere; only `'memory'` is). If a user ever registers a genuine `mem`
  module, the import pre-existing check's deliberate asymmetry (it lowercases
  but does NOT `mem`-alias the existing table's `vtabModuleName`) is the SAFE
  behavior — a real `mem`-module table is treated as foreign and never
  dropped. Left as-is on purpose.
- The differ's args comparison handles `{}` vs `undefined` (both render `''`),
  case-spelling, and key order. `canonicalBackingModuleArgs` rendering `1` and
  `1n` identically cannot misfire (parser produces only string/number args).
- The configurable `default_vtab_module` (used by CREATE TABLE when USING is
  omitted) does NOT redirect the MV backing default — it stays hardcoded
  `memory`. Deliberate per ticket ("memory default unchanged"); the
  `store-mv-backing-host` follow-on owns durable-default behavior.
- Import drop-then-materialize ordering: a same-module pre-existing backing is
  dropped before the refill, so a subsequently failing entry (unplannable
  body) loses the old backing. Accepted: backing content is derived and
  refillable by design (the documented rehydrate-refill position); the
  other-module guard is what protects non-derived user data.
- Behavioral change noted by the implementer and accepted: a pre-existing
  `_mv_<name>` table in the DEFAULT memory module is now dropped + refilled on
  import of a default-backed MV (previously a collision error) — the
  same-module rule applied uniformly.

**Minor — fixed in this pass**:

- `docs/schema.md` was stale in three places the implement commit missed:
  the DDL-generation paragraph still said `generateMaterializedViewDDL`
  "deliberately omits the USING clause / backing always memory"; the
  `importCatalog` bullet still said "the memory backing table is rebuilt" with
  no mention of the clause or the pre-existing-backing handling; and the
  view/MV definition-change-detection section did not mention the separate
  backing-module comparison. All three updated.
- `CreateMaterializedViewNode.getLogicalAttributes()` included
  `backingModuleName` but omitted `backingModuleArgs` — added (debug/plan
  output completeness).
- The handoff's self-identified test gap — `registerMaterializedView`-failure
  (row-time eligibility) rollback asserted against a NAMED module's table map
  on import — closed with a new test in `view-mv-ddl-persistence.spec.ts`
  (`using mem2` + `random()` body ⇒ per-entry error, no MV record, no backing
  in mem2).

**Major — none.** No new tickets filed.

**Accepted gaps (not fixed, with reasons)**:

- Host-without-`alterTable` rename staleness is documented, not tested:
  building a full custom backing-host module just to omit `alterTable` is out
  of proportion; the UNSUPPORTED throw + mark-stale failure path is
  pre-existing code with its own coverage.
- `mvModuleClauseToString` renders string arg values via `JSON.stringify`
  (double quotes → re-parsed as identifiers mapping back to the same string).
  Round-trips and is fixed-point (tested) but stylistically diverges from the
  table USING clause's single-quoted render. Pre-existing; untouched to avoid
  churning persisted DDL.
- `yarn test:store` not re-run in review: the implementer ran it green at the
  same behavioral code state; the review delta is debug-output, a test, and
  docs only.

## Validation

- `yarn build` — clean (all packages).
- `yarn lint` (packages/quereus) — clean.
- `yarn test` — all workspaces green; quereus 5648 passing / 9 pending.
- `yarn test:store` — green at implement time (5643 passing, 13 pending);
  not re-run (see above).
