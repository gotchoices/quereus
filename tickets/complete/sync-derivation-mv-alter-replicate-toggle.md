description: Live ALTER materialized view toggle of `quereus.sync.replicate` for store-hosted MVs
files:
  - packages/quereus-store/src/common/store-module.ts      # onEngineSchemaChange MV arms + refreshConnectedMaterializedView helper
  - packages/quereus-store/test/backing-host.spec.ts       # MV replicate toggle tests (~:581)
  - packages/quereus-store/src/common/backing-host.ts      # StoreBackingHost.replicates (tag read locus)
---

# Live ALTER toggle of `quereus.sync.replicate` on store-hosted MVs

## Summary

Fixed a silent no-op: `alter materialized view mv {add,drop} tags ("quereus.sync.replicate")`
on an already-connected store-hosted MV had no effect until reopen, because
`StoreModule.onEngineSchemaChange`'s MV arms persisted the new DDL but never refreshed the
live `StoreTable`'s cached schema. `StoreBackingHost.replicates` reads
`this.table.getSchema().tags?.[SYNC_REPLICATE_TAG]` off that cached instance, so it stayed
pinned to the create-time tag set. The sibling `table_modified` arm already did the
synchronous cache refresh — the MV arms now match it.

## Review findings

### What was checked
- **Implement diff** (`7917aa15`) read first, fresh, before the handoff summary.
- **Root-cause chain** independently traced: `getBackingHost` → `resolveOwnedTable` →
  `this.tables` lookup → `StoreBackingHost(table, ...)`; `replicates` reads
  `this.table.getSchema()`; `updateSchema` replaces `this.tableSchema` in place. Confirmed the
  fix mutates the *same* `StoreTable` instance `getBackingHost` resolves, and that the
  cache-lookup key (`${schema}.${object}`.toLowerCase()) matches `resolveOwnedTable`'s key and
  the existing `table_modified` arm.
- **Event-field correctness**: `materialized_view_added`/`_modified` carry the payload on
  `event.newObject`, `_refreshed` on `event.object` — matches the pre-existing structure.
- **Reconnect safety**: when no live `StoreTable` is connected, the cache push is correctly
  skipped and a later `getBackingHost` reconnect rebuilds from the freshly-persisted DDL — so
  correctness holds whether or not an instance is currently connected.
- **Docs**: `docs/migration.md` and `packages/quereus-store/README.md` describe
  `quereus.sync.replicate` as a per-table opt-in with no "reopen required" claim — the fix
  aligns behavior with already-documented intent, so no doc edit was warranted.
- **Tests**: ran `yarn workspace @quereus/store run test` (599 passing, 1 pending — the
  pre-existing echo-loop quiescence stub) and `yarn workspace @quereus/store run build` (clean,
  type-checks the source). Re-ran both after the inline fix below — still green.

### Findings & disposition
- **Minor (fixed inline) — DRY**: the `_added`/`_modified` and `_refreshed` arms were
  byte-identical except the payload field, and this change amplified the duplication
  (cache-lookup + `updateSchema` + `enqueuePersist` repeated). Extracted a private
  `refreshConnectedMaterializedView(schemaName, objectName, payload)` helper that narrows via
  `isMaintainedTable`, refreshes a connected `StoreTable`'s cache, then enqueues the DDL
  persist. Both arms now delegate to it. No behavior change; build + tests re-verified.
- **No major findings** — nothing filed as a new ticket. The fix is minimal, correctly scoped
  to the store module, and exercises the actual bug locus (`StoreBackingHost.replicates`).

### Coverage assessment (gaps that are acceptable, with reasons)
- **No end-to-end (source DML → REFRESH → emit) test**: the added tests drive
  `host.applyMaintenance` directly, which is the exact code path that reads the (previously
  stale) tag cache. The bug is a cache-staleness bug, not a maintenance-derivation bug, so the
  direct path is the correct and sufficient level.
- **No dedicated `materialized_view_refreshed` test**: REFRESH does not normally change tags,
  and the cache push is a no-op when the schema object is unchanged. The arm shares the helper
  with `_modified` (which *is* tested), so the tag-re-read code path is covered.
- **Host resolved after the ALTER, not held across it**: an even stronger regression would
  hold a `BackingHost` across the toggle, but since `getBackingHost` resolves fresh each call
  and `replicates` reads `this.table.getSchema()` live off the in-place-mutated `StoreTable`,
  the held-host and resolve-after paths are equivalent — the existing tests already prove the
  cache refresh.

## Tests added (implement stage, retained)
`backing-host.spec.ts`, parameterized over `EMIT_FLAVORS`:
- create-time `replicate = true` → emits on maintenance
- no tag → no emit (default-off baseline)
- ALTER add-tags → emission turns on without reopen (primary bug case)
- ALTER drop-tags → emission turns off without reopen (symmetric regression guard)

## Results
- `yarn workspace @quereus/store run test`: **599 passing, 1 pending, 0 failing**
- `yarn workspace @quereus/store run build`: clean (exit 0)
