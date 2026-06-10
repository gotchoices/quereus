description: Review the unification of materialized-view rehydration under `SchemaManager.importCatalog` — the create-MV materialize core was extracted into a shared `materializeView` helper called from both the create emitter and a new silent `importMaterializedView`, and the store's phase-3 `db.exec` loop was replaced with `importCatalog`.
files:
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts   # new MaterializeViewDefinition + materializeView (the extracted core)
  - packages/quereus/src/runtime/emit/materialized-view.ts           # create emitter rewired onto the helper
  - packages/quereus/src/schema/manager.ts                           # importMaterializedView; importDDL/importCatalog arms; result gains materializedViews
  - packages/quereus-store/src/common/store-module.ts                # rehydrate phase 3 now importCatalog; docstrings updated
  - packages/quereus-store/src/common/key-builder.ts                 # decodeMaterializedViewCatalogKey removed (dead)
  - packages/quereus-store/src/common/index.ts                       # export removed
  - packages/quereus/test/view-mv-ddl-persistence.spec.ts            # new MV-import engine tests (replaced the "fails loud" test)
  - packages/quereus/test/index-ddl-roundtrip.spec.ts                # empty-DDL no-op expectation widened to the new result shape
  - packages/quereus-store/test/view-mv-persistence.spec.ts          # new ineligible-body rehydrate-error test
  - docs/schema.md                                                   # importCatalog section + Rehydrate phasing updated
  - packages/quereus-store/README.md                                 # rehydrate description + export table updated
----

# Review: MV rehydration unified under importCatalog

## What was done

- **Extracted `materializeView(db, def)`** into `materialized-view-helpers.ts`
  (with a `MaterializeViewDefinition` input shape satisfied by both the create
  plan node and a re-parsed catalog entry). It performs exactly the create
  emitter's core: `deriveBackingShape` → `buildBackingTableSchema` →
  `createBackingTable` → `collectBodyRows` → `replaceBaseLayer` (with the
  "must be a set" duplicate-key diagnostic) → `linkCoveredUniqueConstraints` →
  `addMaterializedView` → `registerMaterializedView`, with the identical
  rollback-on-throw (fill failure drops the backing; registration failure also
  unlinks + removes the MV record). It fires `table_added` for the backing (as
  before) but never `materialized_view_added` — the caller decides.
- **Rewired `emitCreateMaterializedView`** onto the helper. Existence/collision
  checks, `_ensureTransaction`, and the `materialized_view_added` notify stay in
  the emitter; behavior and error surfaces are unchanged.
- **Added `importMaterializedView`** to `SchemaManager` plus a
  `createMaterializedView` arm in `importDDL`; `importCatalog`'s result gains
  `materializedViews: string[]`. Import is silent (no MV event), mirrors
  `importView`'s `getOrCreateSchema`, and plans the body eagerly (the backing
  cannot fill without running it) — so MV import is order-dependent by design.
- **Replaced the store's phase-3 `db.exec` loop** with per-entry
  `importCatalog`, preserving tables → views → MVs phasing, per-entry error
  collection, and the **fixpoint retry** for MV-over-MV ordering.
- Removed the now-dead `decodeMaterializedViewCatalogKey` (names now come from
  `importCatalog`'s result, consistent with the table/view phases) — also from
  the package exports and README.
- Docs updated: `docs/schema.md` (importCatalog contract, Rehydrate phasing),
  `packages/quereus-store/README.md`.

## Decisions a reviewer should weigh

- **MV-over-MV ordering stayed fixpoint-retry, not a static topo sort.** The
  ticket asked to "implement/verify topological ordering"; a static sort by
  `sourceTables` is impossible before planning because `sourceTables` (the
  resolved `_mv_<x>` backing names) is computed at plan time and is NOT
  serialized in the DDL. The fixpoint loop is the topological order, discovered
  dynamically; the pre-existing depth-3 chain test passes unchanged. Cost note:
  a failed round repeats the body fill of failed entries (worst case O(n²)
  fills for an n-deep reverse-sorted chain) — identical to the old `db.exec`
  behavior, just relocated.
- **No enclosing transaction on the import path.** The create emitter runs
  inside `_ensureTransaction()`; `importMaterializedView` does not start one.
  `replaceBaseLayer` is self-latching (swaps the memory base layer directly)
  and `collectBodyRows` uses the no-transaction `_iterateRowsRaw` primitive
  (SELECT bodies never lazily start a transaction). All store round-trip tests
  — including MV bodies reading store/LevelDB tables — pass, but this is the
  one semantic difference from the old `db.exec` path worth an adversarial
  look (e.g. a store table whose cursor assumes an open transaction).
- **Event-churn change (intended):** the old re-exec re-fired
  `materialized_view_added` (compare-skipped by the listener); import fires
  nothing for the MV. The backing's `table_added` still fires in both worlds.
  The "second consecutive reopen yields identical catalog bytes" test still
  passes.
- **Name casing nuance:** `RehydrationResult.materializedViews` entries now
  take identifier case from the DDL (matching the table/view phases) instead
  of the lowercased catalog key. All current consumers/tests use lowercase.

## Validation performed

- `yarn build` (all packages), `yarn lint` (quereus): clean.
- `yarn test` (full workspace): all passing. One expectation updated in
  `index-ddl-roundtrip.spec.ts` ("empty DDL is a no-op" deep-equals the import
  result object) — a direct consequence of the widened result shape.
- `yarn test:store` (logic tests on LevelDB): 5544 passing.
- Pre-existing round-trip suite (`view-mv-persistence.spec.ts`) passes
  unchanged: reopen rebuild + live maintenance, tags, durable drop, refresh
  no-churn, mixed classification, view-over-MV, MV-over-MV, depth-3 chain,
  idempotent second reopen, memory-source error.
- New engine tests (`view-mv-ddl-persistence.spec.ts`): silent MV import
  (backing rebuilt + filled, post-import insert/update/delete maintained, name
  in `.materializedViews`, no `materialized_view_added`); MV-over-MV import in
  producer-first order with cascade maintenance; ineligible body (random()
  column — fails `registerMaterializedView`'s gate) throws and rolls back with
  no MV and no backing left; duplicate-producing body throws "must be a set"
  and rolls back.
- New store test: a hand-planted catalog entry with an ineligible body records
  exactly one `RehydrationResult.errors` entry (matching /non-deterministic/)
  while the sibling MV still rehydrates — exercising repeated rollback across
  two fixpoint rounds.

## Known gaps / review starting points

- No test covers an MV import whose body reads a **partially-imported** world
  mid-`importCatalog` array beyond producer-first ordering; the store always
  feeds one entry per call, so the multi-entry array path is only covered by
  the engine MV-over-MV test.
- The import path's lack of a transaction wrapper (above) is reasoned + tested
  but not exhaustively proven against every vtab module a body might read.
- `manager.ts` now imports `runtime/emit/materialized-view-helpers.js` —
  schema→runtime layering. Type-only cycles through `planner` already existed
  (e.g. manager ↔ planning-context) and nothing in the helper graph
  dereferences manager exports at module-evaluation time, but a reviewer may
  want to confirm the dependency direction is acceptable or suggest a better
  home for the helper.
- The downstream `mv-backing-module-pluggability` plan ticket generalizes this
  core: the helper deliberately keeps backing creation/fill behind
  `buildBackingTableSchema` / `createBackingTable` / `getBackingManager` and
  adds no new memory-module specifics.
