description: Durable-backing adopt fast path — at catalog rehydrate, trust a store-hosted `_mv_` backing and skip the body re-fill when ALL gates pass: same-module backing exists (phase-1 rehydrated), shape matches the re-planned body, every source resolves to the backing's module (with `_mv_` sources themselves adopted), and the store attests a clean shutdown via a catalog marker. Anything else keeps today's drop+refill.
prereq: store-backing-host
files:
  - packages/quereus/src/schema/manager.ts                          # importCatalog options; importMaterializedView adopt arm
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts  # adoptMaterializedView helper next to materializeView
  - packages/quereus-store/src/common/store-module.ts               # clean-shutdown marker write/consume; rehydrate threading
  - packages/quereus-store/src/common/key-builder.ts                # reserved \x00meta\x00 catalog prefix + classify kind
  - packages/quereus-store/test/mv-rehydrate-adopt.spec.ts          # NEW: reopen matrix (sentinel-divergence probe)
  - docs/materialized-views.md                                      # rehydrate/adopt semantics (replaces "future fast path" note)
  - docs/schema.md                                                  # importCatalog options bullet
----

# Adopt-without-refill at rehydrate

Third step (after `store-backing-host`). Upgrades the same-module
pre-existing-backing arm in `SchemaManager.importMaterializedView` (landed in
`mv-backing-using-module`) from unconditional drop+refill to gate-checked
trust.

## The atomicity finding and gate (5)

The plan pass **verified that "one store commit" does NOT hold**: coordinators
are per table, `TransactionCoordinator.commit` writes a separate batch per KV
store, and the LevelDB provider opens a separate database per table — even one
table's data-vs-secondary-index commit is two batches. So gate (4)
(same-module sources) alone cannot prove the backing clean after a crash, and
shape/hash gates are DDL-level (blind to content divergence) — an unsound
adopt would resurrect crash divergence forever.

Design response: a **clean-shutdown marker** in the catalog store.

- Reserved key under a new `\x00meta\x00` catalog prefix (key-builder), e.g.
  `\x00meta\x00clean_shutdown`. `classifyCatalogKey` gains a `'meta'` kind;
  `rehydrateCatalog` skips meta entries (today an unknown key would be fed to
  the table phase and error).
- `StoreModule.closeAll` writes the marker AFTER unsubscribing, draining
  `persistQueue`, and disconnecting tables (all batches flushed), immediately
  before `provider.closeAll`.
- `rehydrateCatalog` reads the marker FIRST, records `wasCleanShutdown`, and
  **deletes it immediately** — single-use, so a crash later in this session is
  detected at the next open, and a second rehydrate without an intervening
  clean close refills.
- Crash ⇒ no marker ⇒ every adopt falls back to refill ⇒ divergence
  self-heals (the documented rehydrate-refill position). Hosts that never call
  `closeAll` simply never adopt — conservative.

This is the verified substitute for the plan's "verify one commit or design
the batch-join": the batch-join needs a provider-level multi-store atomic
batch that no provider has (parked as `store-atomic-multi-store-commit` in
backlog/; landing it would let adopt drop this gate).

## Adopt gates (final)

In `importMaterializedView`'s pre-existing-backing branch (create NEVER
adopts; refresh unchanged), adopt iff ALL of:

1. a table exists at `_mv_<name>` whose `vtabModuleName` equals the MV's
   declared backing module (the existing arm condition);
2. `backingShapeMatches(preExisting, deriveBackingShape(db, bodySql, columns))`;
3. bodyHash — **automatic by construction**: the catalog persists DDL, import
   re-parses it and recomputes `computeBodyHash` from the same canonical
   definition, so there is no independent persisted hash to diverge. Assert
   this in a comment (no runtime check possible or needed);
4. every entry in the derived `sourceTables` resolves in the schema manager to
   a table whose module equals the backing module, AND every `_mv_` source is
   in the import session's `adoptedBackings` set (an upstream MV that was
   REFILLED this rehydrate may have new content — its dependents must refill
   too; an upstream that ADOPTED is unchanged, so trust composes);
5. the caller asserted trust: `importCatalog` option `trustBackings: true`
   (set by `rehydrateCatalog` from the consumed marker).

Fail any ⇒ today's drop + `materializeView` refill (already landed). On adopt
success, add the backing's lowercased qualified name to `adoptedBackings`.

## Engine changes

- `importCatalog(ddlStatements, options?: { trustBackings?: boolean; adoptedBackings?: Set<string> })`
  — threaded through `importDDL` to `importMaterializedView`. Existing callers
  unchanged (options optional; quoomb-web reads only `.errors`).
- `adoptMaterializedView(db, def, preExisting)` in
  `materialized-view-helpers.ts`, beside `materializeView`: the registration
  tail without create+fill —
  - `deriveBackingShape` (the caller already computed it for gate 2 — pass it
    in, don't re-plan);
  - **re-stamp the registered backing schema** with the body-derived
    `buildBackingTableSchema(...)` result (shape-verified identical): the
    phase-1 schema is a DDL round-trip and loses ScalarType fidelity that the
    refill path would carry; re-stamping (schema-manager re-register +
    `StoreTable.updateSchema` via the module's `table_modified` listener or a
    direct update) makes post-adopt state byte-equivalent to post-refill state
    for the row-time plan that `registerMaterializedView` binds. Preserve the
    registered module identity/args.
  - build the `MaterializedViewSchema` exactly as `materializeView` does
    (same `bodyHash` formula, `primaryKey`/`ordering`/`sourceTables` from
    shape, `stale: false`, `origin: 'explicit'`);
  - `linkCoveredUniqueConstraints` → `addMaterializedView` →
    `registerMaterializedView`;
  - rollback on registration failure (row-time eligibility gate): unlink +
    `removeMaterializedView` + rethrow, but **leave the backing table
    registered** (it reverts to its phase-1 plain-table state; the entry is
    recorded as a per-entry rehydration error — dropping a durable backing on
    a registration error would destroy the very rows a retry could adopt).

## Store changes

- Marker lifecycle as above (`closeAll` write; `rehydrateCatalog` consume).
- Phase 3 passes `{ trustBackings: wasCleanShutdown, adoptedBackings }` into
  each per-entry `importCatalog` call; one shared set across the fixpoint loop
  (rounds compose: an upstream adopted in round 1 enables its dependent in
  round 2).

## Edge cases & interactions

- **Crash-window simulation (the core soundness test)** — plant a sentinel
  divergence directly in the backing's KV store between sessions: adopt
  preserves it (and a SELECT of the MV serves it — proving no refill); any
  failed gate removes it (refill). Use the sentinel as the adopt-vs-refill
  oracle throughout.
- **Marker single-use** — rehydrate twice without an intervening `closeAll` ⇒
  second pass refills. Close cleanly ⇒ next open adopts again.
- **Skip `closeAll`** (simulated crash) ⇒ refill. Fresh store (no marker ever)
  ⇒ refill.
- **Shape perturbation** — hand-edit the persisted SOURCE table DDL between
  sessions so a `select *` body re-plans wider ⇒ gate 2 fails ⇒ refill (and
  the refilled backing matches the new shape).
- **Mixed-module sources** — memory source + `using store` backing ⇒ gate 4
  fails every reopen ⇒ always refill (the memory source was itself just
  recomputed; persisted backing rows may be stale relative to it).
- **MV-over-MV** — both store-backed under clean shutdown ⇒ both adopt
  (sentinel survives in both); force the upstream to refill (perturb its
  shape) ⇒ dependent refills despite its own gates passing (`adoptedBackings`
  gate). Memory upstream + store dependent ⇒ dependent refills (gate 4).
- **Other-module pre-existing backing** ⇒ per-entry CONSTRAINT error, table
  untouched (existing arm — regression-pin only).
- **Adopt then registration failure** — an adopted entry whose body fails the
  row-time eligibility gate (would need a hand-edited DDL, e.g. `random()` in
  the body): per-entry error, backing remains as a plain table, no MV record.
- **Meta key never reaches DDL import** — a catalog containing the marker plus
  tables/views/MVs rehydrates with zero errors and zero attempts to parse the
  marker; `loadAllDDL` consumers (tests asserting persisted DDL) — check
  whether the marker value leaking into `loadAllDDL()` output breaks any
  existing assertion; filter meta keys there if so.
- **Adopt and stats** — adopted backing keeps its persisted `__stats__` row
  count (a small bonus; no action, but don't reset stats on adopt).
- **DDL canonicalization drift** — adopt path must use the same normalized
  module identity (`normalizeBackingModule`) and canonical `sql` the refill
  arm records, so a later differ pass sees no drift between an adopted and a
  refilled MV record (fixed-point test: export DDL after adopt == after
  refill).

## Tests

`packages/quereus-store/test/mv-rehydrate-adopt.spec.ts` with a
persistence-faking in-memory provider (byte maps survive `closeAll`/reopen —
build a small test provider over `InMemoryKVStore` data maps if the store
tests don't already have one) — the full matrix above. Plus the engine-side
unit: `importCatalog` options default (no `trustBackings`) ⇒ refill even when
all other gates pass.

`yarn build`, `yarn lint`, `yarn test`, and one `yarn test:store` run.

## Docs

- `docs/materialized-views.md` — replace the "future adopt-without-refill fast
  path" sentence in § Cross-module atomicity with the realized semantics: the
  five gates, the clean-shutdown marker, why same-module + marker (not "one
  commit") is the trust basis, and the refill-heals fallback.
- `docs/schema.md` — `importCatalog` options bullet.
- `docs/module-authoring.md` — note: a durable backing host wanting the adopt
  fast path persists its backing as an ordinary table entry and passes
  `trustBackings` only when it can attest no crash since the last open.

## TODO

- key-builder meta prefix + classify kind; rehydrate meta skip
- closeAll marker write; rehydrateCatalog consume + threading
- importCatalog/importDDL/importMaterializedView options + adopt arm
- adoptMaterializedView helper (+ backing schema re-stamp) with rollback rules
- Reopen test matrix (sentinel probe) + engine options unit test
- Docs (three files); build/lint/test + test:store
