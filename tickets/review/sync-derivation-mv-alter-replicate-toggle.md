----
description: Review fix: live ALTER materialized view tags toggle for quereus.sync.replicate
files:
  - packages/quereus-store/src/common/store-module.ts      # onEngineSchemaChange MV arms (~:2321)
  - packages/quereus-store/test/backing-host.spec.ts       # new MV replicate toggle tests (~:581)
----

# Review: MV ALTER live-toggle of `quereus.sync.replicate`

## What was done

Fixed a silent no-op bug: `alter materialized view mv {add,drop} tags ("quereus.sync.replicate")` on an already-connected store-hosted MV had no effect until reopen.

### Root cause

`StoreModule.onEngineSchemaChange` handled `materialized_view_added`/`_modified`/`_refreshed` by enqueuing `saveMaterializedViewDDL` only — it never called `connected.updateSchema(mv)` on the live `StoreTable`. `StoreBackingHost.replicates` reads `this.table.getSchema().tags?.[SYNC_REPLICATE_TAG]` off that cached instance, so it remained pinned to the create-time tag set. The sibling `table_modified` arm already did the synchronous cache refresh (which is why the plain-table toggle worked).

### Fix (`store-module.ts`)

In `onEngineSchemaChange`, the `materialized_view_added`/`_modified` and `materialized_view_refreshed` cases now:
1. Look up the connected `StoreTable` by `${schemaName}.${objectName}`.toLowerCase()
2. Call `connected.updateSchema(mv)` synchronously before `enqueuePersist`
3. Enqueue `saveMaterializedViewDDL` as before

Doc comment updated to note the cache-refresh parity with `table_modified`.

### Tests (`backing-host.spec.ts`)

Added a `for (const flavor of EMIT_FLAVORS)` suite covering both registration shapes:
- **create-time tag = true** → maintenance emit works immediately
- **no tag** → no emit (default off baseline)
- **ALTER add-tags** → turns emission on without reopen (the primary bug case; was failing before fix)
- **ALTER drop-tags** → turns emission off without reopen (symmetric regression guard; was failing before fix)

## Results

- 599 passing, 1 pending (pre-existing echo-loop quiescence stub), 0 failing
- `yarn workspace @quereus/store run build` succeeds (no output = clean)

## Known gaps

- **Direct `applyMaintenance` only**: tests drive the backing host directly. An end-to-end variant (source DML → `refresh materialized view` → emit) was not added — the direct path exercises the tag-read code path (`StoreBackingHost.replicates`), which is the locus of the bug, so this is the correct level.
- **`materialized_view_refreshed` path**: the code fix covers this case (parity), but no dedicated test for the refresh-time tag re-read was added since REFRESH doesn't normally change tags. The synchronous cache push is still a no-op when tags are unchanged (identical `tableSchema` object), so correctness is preserved.
- Engine-side files (`manager.ts`, `change-events.ts`) were not modified — this is a store-module + spec change only.
