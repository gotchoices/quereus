description: Persist the user tags on an *exposed implicit index* (held on `UniqueConstraintSchema.exposedIndexTags`, separate from the bundled `CREATE INDEX` DDL) for store-backed databases, so `ALTER INDEX … SET/ADD/DROP TAGS` on an exposed implicit (UNIQUE-derived) index round-trips across close → reopen.
prereq:
files:
  - packages/quereus/src/schema/table.ts            # UniqueConstraintSchema.exposedIndexTags
  - packages/quereus/src/schema/catalog.ts          # catalog snapshot / DDL emission
  - packages/quereus/src/schema/ddl-generator.ts    # generateTableDDL / generateIndexDDL (bundle)
  - packages/quereus-store/src/common/store-module.ts  # buildCatalogEntry / persistCatalogIfChanged
  - docs/schema.md                                  # "exposed implicit index user tags" gap note
  - packages/quereus-store/README.md               # remaining-gap note
----

# Persist exposed-implicit-index user tags for store-backed catalogs

## Background

When a UNIQUE constraint's implicit index is **exposed** (made addressable /
introspectable), user tags applied to that exposed index are stored on
`UniqueConstraintSchema.exposedIndexTags` — a field **separate** from the bundled
`CREATE INDEX` DDL that the store catalog persists via
`buildCatalogEntry` → `generateTableDDL` / `generateIndexDDL`.

The store's table catalog bundle does not currently round-trip `exposedIndexTags`,
so an `ALTER INDEX <exposed-implicit-index> SET/ADD/DROP TAGS` is lost on
close → reopen → `rehydrateCatalog` for `using store` tables. This is the one
remaining catalog-tag-persistence gap after:

- `store-secondary-index-persistence` (bundled secondary-index DDL incl. ordinary
  index tags) — **complete**.
- `store-view-mv-catalog-persistence` (view / materialized-view DDL + tags) —
  **complete**.

The docs (`docs/schema.md` § *Persistence of catalog-only tag swaps*, and
`packages/quereus-store/README.md`) describe this gap and currently point it at the
already-completed `store-secondary-index-persistence` ticket; this ticket is the
correct tracking home and the docs reference it instead.

## Expected behavior

For a `using store` table whose exposed implicit (UNIQUE-derived) index carries
user tags:

- `ALTER INDEX <name> SET TAGS (...)` / `ADD TAGS (...)` / `DROP TAGS (...)` on the
  exposed implicit index updates `exposedIndexTags` (existing engine behavior) **and**
  is re-persisted to the `__catalog__` entry (new).
- After close → reopen → `rehydrateCatalog`, the rehydrated schema reports the same
  `exposedIndexTags`.

## Use case

A schema author tags an exposed implicit unique index (e.g. a behavioral or
documentation tag) and expects that tag to survive a durable reopen, exactly as
table / column / named-constraint / ordinary-index / view / MV tags now do.

## Notes / open questions for the implementer

- Decide the serialization vehicle: extend the bundled table DDL so the exposed
  implicit index's tags survive a `generate → parse → import` round-trip, or carry
  `exposedIndexTags` through the catalog snapshot. Prefer reusing the existing
  schema→AST-lift DDL path (no hand-rolled serialization) to stay drift-free with
  the declarative path, consistent with `generateTableDDL` / `generateIndexDDL`.
- The store already subscribes to `table_modified`; confirm whether an
  `ALTER INDEX … SET TAGS` on an exposed implicit index fires `table_modified` on
  the owning table (the existing index-tag path relies on this) so the persistence
  rides the existing listener with no new plumbing.
