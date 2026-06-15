description: A live `alter materialized view … {set,add,drop} tags ("quereus.sync.replicate")` on a store-hosted, already-connected materialized view is a silent no-op until reopen. The store module's `onEngineSchemaChange` handles `materialized_view_added`/`_modified` by enqueuing `saveMaterializedViewDDL` only — it never refreshes the connected `StoreTable`'s cached schema, so `StoreBackingHost.replicates` (which reads `this.table.getSchema().tags?.["quereus.sync.replicate"]`) keeps seeing the create-time tag set. The sibling `table_modified` case DOES call `connected.updateSchema(event.newObject)`, which is why the plain `create table … using store` + `alter table … tags` live-toggle already works. Fix: mirror that synchronous cache refresh in the MV case.
prereq:
files:
  - packages/quereus-store/src/common/store-module.ts            # onEngineSchemaChange: table_modified refreshes cache (~:2298); materialized_view_added/_modified (~:2321) and _refreshed (~:2329) do not
  - packages/quereus-store/src/common/backing-host.ts            # StoreBackingHost.replicates reads this.table.getSchema().tags?.[SYNC_REPLICATE_TAG] (~:224)
  - packages/quereus-store/src/common/store-table.ts             # StoreTable.updateSchema cached-schema swap (~:250); getSchema (~:246)
  - packages/quereus/src/schema/manager.ts                       # updateMaterializedViewTags: {...table, tags} swap + materialized_view_modified fire (~:1140), never touches module StoreTable cache
  - packages/quereus/src/schema/change-events.ts                 # MaterializedViewModifiedEvent / _refreshed event shapes (~:65-104)
  - packages/quereus-store/test/backing-host.spec.ts             # existing repl ALTER add/drop-tags live-toggle tests (table_modified path, ~:553); flavor loop (~:69) + emitter-carrying repl describe (~:417)
difficulty: easy
----

# MV ALTER live-toggle of `quereus.sync.replicate` is a silent no-op until reopen

## Symptom

For a **store-hosted materialized view** that is already connected (the common
case immediately after `create materialized view … using store` + create-fill):

```sql
create materialized view mv ... using store;          -- replicate OFF (no tag)
alter materialized view mv add tags ("quereus.sync.replicate" = true);
-- subsequent maintenance writes STILL emit no DataChangeEvents
```

and symmetrically a `drop tags` on an MV created **with** the tag keeps
replicating. The toggle only takes effect after the `StoreTable` is evicted from
`this.tables` and rebuilt from the registered schema (reopen / evict + reconnect).

## Root cause (verified)

In the unified model a maintained table **is** a table: a store-hosted MV is a
`StoreTable` keyed in `StoreModule.tables` under `${schema}.${mvName}` (the same
key `getBackingHost` → `resolveOwnedTable` resolves), and `StoreBackingHost`
binds that instance. `StoreBackingHost.replicates`
(`backing-host.ts` ~:224) reads `this.table.getSchema().tags?.[SYNC_REPLICATE_TAG]`
off that cached `StoreTable`.

`SchemaManager.updateMaterializedViewTags` (`manager.ts` ~:1140) performs a
catalog-only swap — `const updated = { ...table, tags: compute(table.tags) };
schema.addTable(updated);` — then fires `materialized_view_modified` with
`newObject = updated`. It never calls into the store module, so the connected
`StoreTable`'s cached schema is untouched.

`StoreModule.onEngineSchemaChange` (`store-module.ts` ~:2321) handles
`materialized_view_added`/`_modified` by enqueuing `saveMaterializedViewDDL(mv)`
**only**. Unlike the `table_modified` arm right above it (~:2298), which does:

```ts
const tableKey = `${event.schemaName}.${event.objectName}`.toLowerCase();
const connected = this.tables.get(tableKey);
if (connected) connected.updateSchema(event.newObject);
```

the MV arm performs no `updateSchema`, so the backing host's `replicates` read
stays pinned to the create-time tag set until the instance is rebuilt.

`event.newObject` is the swapped `MaintainedTableSchema` (a `TableSchema`) — the
**same shape** the connected `StoreTable` already holds, with only `tags`
changed. `StoreTable.updateSchema` (`store-table.ts` ~:250) recomputes
`pkDirections` / `pkKeyCollations` from the (unchanged) columns/PK — a no-op there
— and swaps the cached `tableSchema`, which is exactly what the tag read needs. It
does not choke on the `derivation` field (it ignores everything but
columns/primaryKeyDefinition).

This gap pre-dates the `quereus.sync.replicate` work (the MV `_modified` handler
never refreshed the connected cache) but was behaviorally invisible until this
tag made an MV's runtime behavior depend on its live tags.

## Fix

In `onEngineSchemaChange`, mirror the `table_modified` synchronous cache refresh
in the MV arm. The refresh must run **synchronously in the listener** (not inside
the `enqueuePersist` async work), exactly like `table_modified`, so a maintenance
write that follows the ALTER on the same tick sees the new tags. Look up the
connected instance by `${event.schemaName}.${event.objectName}`.toLowerCase() and
call `connected.updateSchema(mv)` when present, before enqueuing the DDL persist.

`materialized_view_added` (create) does **not** strictly need it — the `StoreTable`
is freshly built from the registered (with-tags) schema, so its cache is already
current — but the `_added`/`_modified` case is shared and applying `updateSchema`
on `_added` is a harmless same-shape re-push, so the single shared block is fine.

`materialized_view_refreshed` carries the schema on `event.object` (not
`newObject`). REFRESH normally leaves tags unchanged, but the same staleness would
apply if a refresh ever swapped them, so give it the parity refresh too (cheap;
`persistCatalogIfChanged`-style compare-skip already guards the DDL write, and the
cache push is a same-shape no-op when nothing changed).

Suggested shape (verify against the live code around `store-module.ts:2321`):

```ts
case 'materialized_view_added':
case 'materialized_view_modified': {
	const mv = event.newObject;
	if (isMaintainedTable(mv)) {
		const key = `${event.schemaName}.${event.objectName}`.toLowerCase();
		const connected = this.tables.get(key);
		if (connected) connected.updateSchema(mv);
		this.enqueuePersist(() => this.saveMaterializedViewDDL(mv));
	}
	return;
}
case 'materialized_view_refreshed': {
	const mv = event.object;
	if (isMaintainedTable(mv)) {
		const key = `${event.schemaName}.${event.objectName}`.toLowerCase();
		const connected = this.tables.get(key);
		if (connected) connected.updateSchema(mv);
		this.enqueuePersist(() => this.saveMaterializedViewDDL(mv));
	}
	return;
}
```

Keep the `isMaintainedTable` narrowing as-is (a derivation-less payload would be
an engine bug). Update the `onEngineSchemaChange` doc comment (~:2273) so the
`materialized_view_*` bullet documents the cache refresh, parity with the
`table_modified` bullet.

## Tests

Extend `packages/quereus-store/test/backing-host.spec.ts`. The existing
emitter-carrying `repl` suite (~:417) is the template: it drives the backing host
directly (`host.applyMaintenance(conn, …)` → `conn.commit()`) and asserts the
emitted `DataChangeEvent`s, and already covers the `table_modified` live-toggle
(~:553) and **both** registration shapes via its flavor loop. Add an MV-level
parallel:

- Build a source table + a store-hosted MV over it, e.g.
  `create table src (k integer primary key, v text) using store;` then
  `create materialized view mv as select k, v from src using store`
  (optionally `with tags ("quereus.sync.replicate" = true)` for the create-time
  case). Resolve the host with `storeModule.getBackingHost!(db, 'main', 'mv')`.
- Assert:
  - **create-time** `quereus.sync.replicate = true` → a subsequent
    `host.applyMaintenance(conn, [{ kind: 'upsert', … }])` + commit emits one
    maintenance `DataChangeEvent` (pins view-ddl → backing-schema tag propagation
    end-to-end through `buildBackingTableSchema` — `materialized-view-helpers.ts`
    carries the MV's top-level `tags` onto the backing schema);
  - `alter materialized view mv add tags ("quereus.sync.replicate" = true)` makes
    a subsequent maintenance write emit, **without** reopen;
  - `alter materialized view mv drop tags ("quereus.sync.replicate")` stops
    emission, **without** reopen.
- Run against both registration shapes (isolated `IsolationModule(StoreModule)`
  wrapper + bare `StoreModule`), like the existing opt-in suite — reuse the
  flavor loop the `repl` describe is nested in (note its `flavor.make(provider,
  emitter)` arity for the emitter-carrying flavors).

Confirm each new ALTER-toggle case is RED against the unpatched
`materialized_view_modified` handler and GREEN after the fix (the create-time case
should already be green — it pins the propagation, not the bug).

## Validation

- `yarn workspace @quereus/quereus-store test` (or `yarn test`) — the new spec
  plus the existing backing-host suite must pass.
- `yarn workspace @quereus/quereus-store run build` (or `yarn build`) to type-check
  the spec call sites and the module change.
- Engine-side `manager.ts` / `change-events.ts` are unchanged — this is a
  store-module + spec change only.

## TODO

- Add the synchronous connected-`StoreTable` cache refresh
  (`connected.updateSchema(mv)`) to the `materialized_view_added`/`_modified` and
  `materialized_view_refreshed` arms of `StoreModule.onEngineSchemaChange`
  (`store-module.ts` ~:2321 / ~:2329), before the `enqueuePersist` call.
- Update the `onEngineSchemaChange` doc comment (~:2273) to note the MV cache
  refresh (parity with the `table_modified` bullet).
- Add MV-level create-time + ALTER add/drop-tags live-toggle tests to
  `backing-host.spec.ts`, across both registration shapes; verify RED-before /
  GREEN-after for the ALTER cases.
- Run `yarn build` + the store package tests; hand off to review honest about any
  gaps (e.g. whether an end-to-end source-DML cascade variant was added or only the
  direct-`applyMaintenance` variant).
