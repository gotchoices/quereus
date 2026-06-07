description: Store-backed secondary indexes do not survive close → reopen — the store catalog persists only table DDL (keyed by schema.table), `generateTableDDL` does not serialize indexes, and `StoreModule.createIndex` writes nothing to the catalog. Index metadata (and therefore `ALTER INDEX … SET TAGS` tags) is lost on rehydrate; the on-disk index store is orphaned.
files:
  - packages/quereus-store/src/common/store-module.ts   # createIndex / dropIndex (no catalog write today); loadAllDDL / rehydrateCatalog
  - packages/quereus/src/schema/ddl-generator.ts        # generateIndexDDL exists but is unused by store persistence
  - packages/quereus-store/src/common/key-builder.ts    # catalog keying (schema.table today; would need an index key namespace)
----

# Persist store-backed secondary indexes across reconnect

## Concern

The generic store module persists a table's DDL to the `__catalog__` store keyed
by `{schema}.{table}` and rehydrates by re-parsing those `CREATE TABLE` strings.
`CREATE INDEX` is a separate statement — `generateTableDDL` does not (and cannot)
embed it — and `StoreModule.createIndex` builds the physical index store but never
writes any `CREATE INDEX` DDL to the catalog. As a result:

- A secondary index created on a store-backed table is **not rehydrated** after
  close → reopen → `rehydrateCatalog`; its backing KV store is left orphaned.
- Consequently `ALTER INDEX … SET TAGS` / `setIndexTags` tags cannot round-trip,
  even though `setIndexTags` fires `table_modified` on the owning table — the
  re-serialized table DDL excludes indexes, so the
  `tag-mutation-store-persistence` listener correctly skips it.

This is an observation surfaced while planning `tag-mutation-store-persistence`;
the existing store index tests (`column-default-conflict.spec.ts`) only assert the
*live* index store, never a reopen, so the gap is untested. Confirm the gap before
building (re-check whether any path persists/recreates indexes on rehydrate).

## Expected behavior

- A `CREATE INDEX` (and `CREATE UNIQUE INDEX`) on a `using store` table survives
  close → reopen against the same provider: the index is present in the rehydrated
  schema and is usable/maintained, with its backing store intact (or rebuilt).
- `DROP INDEX` is likewise durable (no resurrection on reopen, no orphaned store).
- `ALTER INDEX … SET TAGS` round-trips through `index_info(...)` after reopen.

## Use case

Persistent (LevelDB / IndexedDB / RN) deployments that rely on secondary indexes
for query performance must not silently lose them — and their tags — on restart.

## Notes / open questions for the planning pass

- Where to persist index DDL: a new catalog key namespace (e.g.
  `{schema}.{table}.idx.{name}`) re-parsed alongside table DDL during
  `rehydrateCatalog`, using the existing `generateIndexDDL`.
- Rebuild-vs-reattach of the physical index store on reopen.
- Interaction with the UNIQUE-derived `derivedFromIndex` synthesized constraint.
- Ordering in `rehydrateCatalog` (tables before their indexes).
