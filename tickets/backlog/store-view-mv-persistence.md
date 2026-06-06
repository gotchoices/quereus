description: The generic store module does not persist views or materialized views in its catalog at all (catalog holds only `CREATE TABLE` DDL keyed by schema.table; there is no createView / saveViewDDL path). Views/MVs declared against a store-backed database are lost on close → reopen, and `ALTER VIEW|MATERIALIZED VIEW … SET TAGS` tags cannot round-trip.
files:
  - packages/quereus-store/src/common/store-module.ts        # catalog store: only saveTableDDL / loadAllDDL / rehydrateCatalog (tables only)
  - packages/quereus/src/schema/manager.ts                   # setViewTags / setMaterializedViewTags fire view_modified / materialized_view_modified
  - packages/quereus/src/schema/change-events.ts             # ViewModifiedEvent / MaterializedViewModifiedEvent
  - packages/quereus/src/schema/catalog.ts                   # createViewToString / createMaterializedViewToString (DDL generation exists)
----

# Persist views and materialized views for store-backed databases

## Concern

Views and materialized views are engine-level catalog objects, not vtab modules.
The store module's `__catalog__` persistence covers **only table DDL** — there is
no `createView` / `saveViewDDL` path, and `rehydrateCatalog` re-parses table DDL
exclusively. So:

- A `CREATE VIEW` / `CREATE MATERIALIZED VIEW` over a store-backed database does
  not survive close → reopen.
- Consequently `ALTER VIEW … SET TAGS` / `ALTER MATERIALIZED VIEW … SET TAGS`
  (and `setViewTags` / `setMaterializedViewTags`) tags cannot round-trip. These
  setters fire `view_modified` / `materialized_view_modified` (deliberately
  **not** `table_modified`), so the `tag-mutation-store-persistence` listener —
  which handles `table_modified` and writes table DDL — has no catalog entry to
  update and correctly skips them.

Surfaced while planning `tag-mutation-store-persistence`. Confirm scope before
building (e.g. whether MV *backing tables* persist as ordinary store tables today
while the MV *definition* does not, which would leave a dangling backing on
reopen).

## Expected behavior

- `CREATE VIEW` and `CREATE MATERIALIZED VIEW` against a store-backed database
  survive close → reopen against the same provider (definition rehydrated; MV
  backing reattached or rebuilt, maintenance re-registered as appropriate).
- `DROP VIEW` / `DROP MATERIALIZED VIEW` are durable.
- `ALTER VIEW|MATERIALIZED VIEW … SET TAGS` round-trips through `schema()` after
  reopen.

## Use case

Persistent deployments that define views / materialized views need them — and
their behavioral `quereus.update.*` / metadata tags — to survive restart.

## Notes / open questions for the planning pass

- Catalog keying + DDL generation: reuse `createViewToString` /
  `createMaterializedViewToString` (catalog.ts) and a view/MV key namespace in the
  store catalog; extend `loadAllDDL` / `rehydrateCatalog` to import them after
  tables.
- MV specifics: backing-table lifecycle on reopen, body-hash continuity, and
  re-registration of row-time maintenance without an unwanted rebuild.
- Once persistence lands, the store can persist tag changes either by also
  subscribing to `view_modified` / `materialized_view_modified` (extending the
  `tag-mutation-store-persistence` listener) or via a view/MV-specific save path.
