description: A live `alter materialized view … {set,add,drop} tags ("quereus.sync.replicate")` on a store-hosted materialized view does not take effect until reopen — the store module's `materialized_view_modified` handler persists the catalog DDL but never calls `updateSchema` on the connected `StoreTable`, so the backing host keeps reading a stale schema (tag absent / present from create time). The sibling `table_modified` handler does call `updateSchema`, which is why the plain `create table … using store` + `alter table … tags` toggle works.
prereq:
files:
  - packages/quereus-store/src/common/store-module.ts            # onEngineSchemaChange: `table_modified` calls connected.updateSchema(event.newObject) (~line 2298); `materialized_view_added`/`_modified` (~line 2321) only enqueue saveMaterializedViewDDL — no updateSchema
  - packages/quereus-store/src/common/backing-host.ts            # StoreBackingHost.replicates reads this.table.getSchema().tags?.[SYNC_REPLICATE_TAG]
  - packages/quereus-store/src/common/store-table.ts             # StoreTable.updateSchema (cached-schema swap)
  - packages/quereus-store/test/backing-host.spec.ts             # existing ALTER add/drop-tags live-toggle tests use a plain `create table … using store` (table_modified path) — add an MV-level case
----

# MV ALTER live-toggle of `quereus.sync.replicate` is a silent no-op until reopen

## Symptom

For a **store-hosted materialized view** that is already connected (the common
case immediately after `create materialized view … using store` + fill):

```sql
create materialized view mv ... using store;          -- replicate OFF (no tag)
alter materialized view mv add tags ("quereus.sync.replicate" = true);
-- subsequent maintenance writes STILL emit no DataChangeEvents
```

and symmetrically a `drop tags` on an MV created **with** the tag keeps
replicating. The toggle only takes effect after the `StoreTable` is dropped from
the module's `tables` map and rebuilt from the registered schema (reopen / evict
+ reconnect).

## Root cause

`StoreBackingHost.replicates` reads `this.table.getSchema().tags?.[SYNC_REPLICATE_TAG]`.
`getBackingHost` → `resolveOwnedTable` → `getOrReconnectTable` returns the
**cached** `StoreTable` instance for an already-connected table, whose
`getSchema()` reflects whatever was last pushed via `StoreTable.updateSchema`.

`SchemaManager.updateMaterializedViewTags` swaps the registered record and fires
`materialized_view_modified`. The store module's `onEngineSchemaChange` handles
that event by enqueuing `saveMaterializedViewDDL` only — it does **not** call
`connected.updateSchema(event.newObject)`. The `table_modified` case right above
it *does* (`store-module.ts` ~line 2304), which is exactly why the existing
spec's ALTER add/drop-tags live-toggle tests pass: they drive a plain
`create table … using store` backing whose ALTER fires `table_modified`, not an
MV firing `materialized_view_modified`.

This gap pre-dates the `quereus.sync.replicate` work (the `materialized_view_modified`
handler never refreshed the connected cache) but was behaviorally invisible until
this tag made an MV's runtime behavior depend on its live tags.

## Expected behavior

A catalog-only tag mutation on a connected store-hosted MV must refresh the
connected `StoreTable`'s cached schema, parity with `table_modified`, so the
backing host's `replicates` read reflects the live tag set without a reopen.

## Likely fix (verify before committing)

In `onEngineSchemaChange`'s `materialized_view_modified` case, mirror the
`table_modified` cache refresh: look up the connected table by
`${schemaName}.${objectName}` and, when present, call
`connected.updateSchema(event.newObject)` before enqueuing the DDL persist.
`event.newObject` is the `MaintainedTableSchema` (a `TableSchema`), so
`updateSchema` should accept it — confirm it does not choke on the derivation
field, and that `materialized_view_added` (create) does not need the same (the
table is freshly built from the registered schema there, so its cache is already
current). Consider whether `_refreshed` needs it too (REFRESH usually leaves
tags unchanged, but the same staleness applies if a refresh ever swaps tags).

## Tests

- Extend `backing-host.spec.ts` (or a new MV-focused spec) with a real
  `create materialized view … using store with tags (…)` and assert:
  - create-time `quereus.sync.replicate = true` emits maintenance events
    (pins the view-ddl → backing-schema tag propagation end-to-end, which the
    current suite only covers by tracing through `buildBackingTableSchema`);
  - `alter materialized view … add tags ("quereus.sync.replicate" = true)` makes
    a subsequent maintenance write emit, **without** reopen;
  - `alter materialized view … drop tags (…)` stops emission, without reopen.
- Run against both registration shapes (isolated wrapper + bare module), like the
  existing opt-in suite.
