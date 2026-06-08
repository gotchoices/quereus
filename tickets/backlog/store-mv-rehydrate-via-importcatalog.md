description: Unify materialized-view rehydration under `SchemaManager.importCatalog` by extracting the create-MV materialize core (derive backing shape → create memory backing → fill from body → register row-time maintenance) into a shared engine helper callable from both the create emitter and a new silent `importMaterializedView`, removing the store-side `db.exec` special case introduced in `store-view-mv-catalog-persistence`. Also harden MV-over-MV rehydration ordering if the initial pass deferred deep nesting.
files:
  - packages/quereus/src/runtime/emit/materialized-view.ts          # create emitter — source of the materialize core to extract
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts  # likely home for the shared helper
  - packages/quereus/src/schema/manager.ts                          # importDDL/importCatalog: add createMaterializedView arm
  - packages/quereus-store/src/common/store-module.ts               # rehydrate: replace MV db.exec phase with importCatalog
----

# Unify MV rehydration under importCatalog

## Background

`store-view-mv-catalog-persistence` rehydrates materialized views by re-running
their DDL through `db.exec` (which reuses the full create emitter to rebuild the
memory backing and re-register row-time maintenance), while tables and plain
views rehydrate through `SchemaManager.importCatalog`. That split was a
deliberate v1 choice: extracting the MV materialize core couples to the row-time
maintenance subsystem and was out of scope for a single implement run, whereas
`db.exec` reuses the already-tested create path wholesale.

The cost of the split: rehydration uses two mechanisms; MV re-execs run inside a
transaction and re-fire `materialized_view_added` (idempotent persist-skip, but
still event churn); and MV rehydration order/error-handling lives store-side
rather than in the engine alongside tables/views.

## Goal

- Extract a reusable engine helper — e.g. `materializeView(db, mvDefinition)` —
  that performs: derive backing shape → `createBackingTable` (memory) → collect
  body rows → `replaceBaseLayer` → `addMaterializedView` → `registerMaterializedView`,
  with the same rollback-on-throw the create emitter has. Call it from both
  `emitCreateMaterializedView` (no behavior change) and a new silent
  `importMaterializedView` in `manager.ts`.
- Add a `createMaterializedView` arm to `importDDL`/`importCatalog` that uses the
  helper without firing `materialized_view_added` (silent, like `importTable`),
  and returns the MV name in the result.
- Replace the store's phase-3 `db.exec` loop with `importCatalog(mvDDLs)`,
  keeping the same tables → views → MVs ordering and per-entry error collection.
- Confirm/keep MV-over-MV dependency ordering (topological by `sourceTables` vs
  other MVs' backing names). If the initial store ticket deferred deep nesting,
  fully handle it here.

## Notes

- This is a refactor toward consistency, not new user-facing behavior — the
  round-trip tests from `store-view-mv-catalog-persistence` should pass unchanged
  (plus a focused engine test for `importCatalog` of an MV: backing rebuilt,
  maintenance live, no event fired).
- Watch the eligibility gate: `registerMaterializedView` throws on a body that is
  not row-time maintainable. On import this should surface as a recorded
  rehydration error (not a hard abort), matching the per-entry error contract.
