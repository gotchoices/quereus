description: Re-persist catalog-only metadata-tag swaps (table / column / named-constraint tags via `ALTER … SET TAGS` and the programmatic `setTableTags`/`setColumnTags`/`setConstraintTags`) for store-backed tables, by subscribing the store module to the engine's `table_modified` schema-change events and re-writing the table's catalog DDL.
files:
  - packages/quereus-store/src/common/store-module.ts        # add the listener, subscribe lazily, drain on closeAll, persist helper
  - packages/quereus-store/src/common/index.ts               # (only if a new symbol needs exporting — likely none)
  - packages/quereus/src/schema/manager.ts                   # getChangeNotifier() — the notifier the store subscribes to (read-only ref)
  - packages/quereus/src/schema/change-events.ts             # SchemaChangeNotifier / TableModifiedEvent shapes
  - packages/quereus/src/schema/ddl-generator.ts             # generateTableDDL — serializes table/column/constraint WITH TAGS (already complete)
  - packages/quereus-store/test/rehydrate-catalog.spec.ts    # model for the new two-phase (create → reopen) round-trip test
  - packages/quereus/test/logic/50-metadata-tags.sqllogic    # canonical SET TAGS SQL syntax (table/column/constraint) to copy into the new spec
----

# Re-persist catalog-only tag swaps for store-backed tables

## Why

`ALTER TABLE … SET TAGS` (and the programmatic `setColumnTags` /
`setConstraintTags` / `setTableTags`) is a **catalog-only** mutation: the
SchemaManager setters swap the in-memory `TableSchema`, re-register it, and fire a
`table_modified` change event via `commitTagUpdate`. They deliberately do **not**
call `module.alterTable` (tags touch no stored row or physical layout, and this
lets SET TAGS succeed on modules with no `alterTable` hook).

The generic store module (`@quereus/quereus-store`) re-serializes a table's
catalog DDL via `saveTableDDL(...)` **only from inside `module.alterTable`** (and
lazily on first store access). A tag-only swap never reaches `alterTable`, so the
on-disk catalog DDL is never refreshed and the tag change is lost on
close → reopen → `rehydrateCatalog`. `generateTableDDL` already serializes table-,
column-, and constraint-level `WITH TAGS`, so the gap is purely "nothing triggers
the re-write," not "tags aren't serializable."

## Resolved design

**Subscribe the store module to the engine's `SchemaChangeNotifier`** (the
ticket's preferred option). This keeps the engine's catalog-only contract intact,
lets the store own its own persistence, and automatically covers any future
catalog-only mutation that fires `table_modified`.

### Where the notifier comes from

`db.schemaManager.getChangeNotifier()` returns the engine `SchemaChangeNotifier`
(`manager.ts:319`). `addListener(listener)` returns an unsubscribe thunk. The
StoreModule is constructed without a `db`, but its `create()` / `connect()` /
`alterTable()` hooks all receive one — subscribe **lazily on the first hook call
that hands us a `db`**, store the unsubscribe thunk and the `db` reference, and
guard so we subscribe exactly once. Tear down in `closeAll()`.

Under `IsolationModule` wrapping, the wrapper delegates `create`/`connect` to the
underlying `StoreModule`, so this lazy-subscribe path still runs. Do **not** key
any filtering off `TableSchema.vtabModule` identity — when wrapped, that points at
the isolation module, not the StoreModule (see the catalog-presence filter below,
which sidesteps the problem entirely).

Assume one `StoreModule` instance serves one `Database`. If a later `create`/
`connect` arrives with a *different* `db` than the one subscribed, leave the
existing subscription in place (do not re-subscribe) and log — multi-database
sharing of a single module instance is out of scope.

### The persist rule (read-compare-write)

The listener handles **`table_modified` events only** (ignore all other event
types for this ticket — see scope note). For each such event:

1. `key = buildCatalogKey(event.schemaName, event.objectName)`.
2. Read the current catalog DDL: `catalogStore.get(key)`.
   - **Absent** → the table is not store-backed in this catalog (e.g. a memory
     table in the same `db`, or a store table never persisted) → **skip**. This
     self-filters foreign-module tables without relying on `vtabModule` identity.
   - **Present** → compute `generateTableDDL(event.newObject)`.
     - DDL **differs** from the stored bytes → `catalogStore.put(key, newDDL)`.
     - DDL **identical** → skip (no redundant write).

Why this single read-compare-write is correct on every path:

- **Tag-only swap** (in scope): `commitTagUpdate` fires `table_modified` with the
  new tags; the catalog still holds the *old* DDL → DDL differs → persisted. A
  clear (`SET TAGS ()`) drops the `WITH TAGS` clause → also differs → persisted,
  so the clear round-trips.
- **Structural ALTER** (addColumn / dropColumn / renameColumn / alterColumn /
  alterPrimaryKey / add|drop|renameConstraint): the store's own `alterTable`
  already wrote the final DDL, and the engine then fires `table_modified` with the
  **same final registered schema** (verified: `runAddColumn` fires
  `enhancedTableSchema` *with* the merged column-level CHECK/FK — so
  `generateTableDDL(newObject)` equals what `alterTable` persisted). Read sees
  identical bytes → skip → **no double-write, no clobber**.
- **Recursion**: `saveTableDDL` writes only the KV catalog store; it fires no
  engine event. So the listener cannot re-trigger itself.
- **Propagated renames** (column/table rename rewriting CHECK/FK or view bodies in
  *dependent* store tables, which fire `table_modified` for tables whose own
  `alterTable` was never called): catalog entry exists, DDL differs → persisted.
  This is a beneficial side effect (those rewrites would otherwise not persist for
  store tables), not a regression — keep it.

### Async-listener handling

`SchemaChangeNotifier.notifyChange` invokes listeners **synchronously** and does
not await them (it only try/catches). Our persist is async (`catalogStore.get` /
`put`). Existing catalog writes in this module (`saveTableDDL` from `alterTable`)
are already **non-transactional** direct `catalogStore.put`s outside the
coordinator, so we introduce no new transactional semantics. To make the write
land before the provider closes:

- Maintain a single serialized `persistQueue: Promise<unknown>` chain so writes
  for the same key apply in order (a `SET TAGS (...)` followed by `SET TAGS ()`
  must end cleared). The listener appends its read-compare-write to the chain.
- `closeAll()` awaits the settled queue before closing the provider.
- Swallow/log persist errors inside the chain (mirror `notifyChange`'s own
  try/catch contract); never let a listener rejection escape.

Within a session, query correctness is unaffected regardless of flush timing —
the in-memory schema already carries the tags (the setter swapped it). Only the
persisted catalog needs draining before close.

### Keep the connected StoreTable instance consistent

`SET TAGS` does **not** call `table.updateSchema(...)`, so a connected
`StoreTable`'s cached `tableSchema` goes stale (no tags). When the event's table
is currently connected (`this.tables.has(key)`), also call
`table.updateSchema(event.newObject)` in the listener so the instance stays
consistent and a later lazy `saveTableDDL` (from `initializeStore`) would not
re-write stale, tag-less DDL. (The listener persists from `event.newObject`, never
from the possibly-stale `StoreTable` cache — this is why reading the event payload,
not the instance, matters.)

## Scope boundary

**In scope (this ticket):** table tags, column tags, and named-constraint
(CHECK / UNIQUE / FK) tags — all route through `commitTagUpdate` → `table_modified`
→ persisted by the listener.

**Out of scope → parked in backlog (genuinely blocked, not deferred-by-choice):**

- **Index tags** (`setIndexTags`, `ALTER INDEX … SET TAGS`): fires `table_modified`
  on the owning table, but `generateTableDDL` does **not** serialize indexes, and
  the store never persists `CREATE INDEX` DDL at all (`createIndex` writes nothing
  to the catalog) — store-backed secondary indexes do not survive reopen today.
  So index tags cannot round-trip until index persistence exists. With this
  ticket's rule, an index-tag event produces identical table DDL → skipped (no
  harm). → backlog `store-secondary-index-persistence`.
- **View / MV tags** (`setViewTags` / `setMaterializedViewTags`, `ALTER VIEW|
  MATERIALIZED VIEW … SET TAGS`): the store does not persist views or materialized
  views in its catalog at all (catalog holds only table DDL; no `createView` /
  `saveViewDDL` path), and these fire `view_modified` / `materialized_view_modified`
  (not `table_modified`). Nothing to update → blocked on store view/MV persistence.
  → backlog `store-view-mv-persistence`.

Both backlog tickets note the tag round-trip as a follow-on once their underlying
persistence lands.

## Edge cases & interactions

- **Mixed modules in one `db`** (a memory table + a store table): a `table_modified`
  for the memory table must NOT write memory-table DDL into the store catalog —
  guaranteed by the catalog-absent skip. Add a test with both a `using memory` (or
  default) table and a `using store` table; SET TAGS on the memory table must leave
  the store catalog untouched.
- **Structural ALTER double-write / clobber**: covered by identical-DDL skip;
  assert (e.g. spy/count catalog puts, or assert post-ALTER DDL equals the
  store-written DDL) that a structural ALTER does not produce a *second*, differing
  write. The `runAddColumn` CHECK/FK-merge case is the one to pin (newObject carries
  merged constraints → must equal alterTable's `persistedSchema` DDL → skip).
- **Clear round-trip**: `SET TAGS ()` on table / column / constraint → reopen →
  tags absent (DDL emitted the `WITH TAGS` previously; clear drops it).
- **Untouched (never-persisted) store table**: a store table CREATEd but never
  accessed has no catalog entry yet (DDL is saved lazily on first store access —
  pre-existing behavior; such tables don't rehydrate at all today). SET TAGS on it
  hits the catalog-absent skip and the tags are not persisted — consistent with the
  table itself not persisting. Document this; do not try to fix it here (a fix
  belongs with eager-create-persist, out of scope). The acceptance test persists
  the table (an INSERT, as `rehydrate-catalog.spec.ts` does) before SET TAGS.
- **Recursion / re-entrancy**: none — `saveTableDDL` fires no engine event. Still
  assert the listener is not invoked re-entrantly (a single SET TAGS yields exactly
  one persist).
- **Ordering**: serialize persists; a `SET TAGS (a=1)` immediately followed by
  `SET TAGS ()` must leave the catalog cleared after the queue drains.
- **`closeAll` drains before provider close**: assert the tag write is visible in
  the catalog store after `closeAll()` resolves (reopen sees it).
- **Unsubscribe on close**: after `closeAll()`, a subsequent `table_modified` on
  the (now-detached) notifier must not write — the listener is removed. (Mostly
  relevant if the same `db` outlives the module; assert the unsubscribe thunk ran.)

## Testing

Primary test home is a **new `packages/quereus-store/test/tag-persistence.spec.ts`**
modeled on `rehydrate-catalog.spec.ts`: the two-phase (db1 creates over a shared
in-memory provider; db2 + fresh `StoreModule` `rehydrateCatalog`s the same
provider) pattern is the only way to express close→reopen, which a single
`.sqllogic` file cannot. This spec runs under the default `yarn test`
(quereus-store is a test workspace) — no need for the slower `yarn test:store`.
(The memory path is already covered by `test/logic/50-metadata-tags.sqllogic`.)

Cases (each: set in phase 1, reopen in phase 2, assert via `db2`):

- **Table tags** set via `alter table T set tags (display_name = 'X', audit = true)`
  → reopen → `db2.schemaManager.getTableTags('T')` (or `select tags from schema()`
  for the table row) deep-equals `{ display_name: 'X', audit: true }`.
- **Column tags** via `alter table T alter column c set tags (searchable = true)`
  → reopen → tag present on the column (`findTable('T').columns[i].tags`, or
  `select tags from table_info('T') where name = 'c'`).
- **Named-constraint tags** via
  `alter table T alter constraint uq_x set tags (msg = 'unique')` → reopen → tag
  present on the constraint (`unique_constraint_info('T')` /
  `check_constraint_info('T')` / `foreign_key_info('T')` TVF row, or the
  `uniqueConstraints`/`checkConstraints`/`foreignKeys` schema entry).
- **Clear** (`set tags ()`) for each of the above → reopen → tags `undefined`/null.
- **Change** (set, reopen-less re-set to a different value, reopen) → reopen sees
  the latest set.
- **Mixed-module isolation**: a non-store table in the same `db` whose SET TAGS
  does not create/modify any store catalog entry.
- **No structural double-write**: an `alter table T add column …` (or any structural
  ALTER) followed by reopen still round-trips correctly, and instrumentation shows
  the `table_modified` listener did not emit a second, differing catalog write.

## TODO

### Phase 1 — listener + subscription

- Add private state to `StoreModule`: `schemaListenerUnsub?: () => void`,
  `subscribedDb?: Database`, and a serialized `persistQueue: Promise<unknown> =
  Promise.resolve()`.
- Add `private ensureSchemaSubscription(db: Database): void` — subscribe once via
  `db.schemaManager.getChangeNotifier().addListener(this.onEngineSchemaChange)`,
  record `subscribedDb` + the unsub thunk; no-op if already subscribed (log if a
  different `db` arrives).
- Call `ensureSchemaSubscription(db)` at the top of `create()`, `connect()`, and
  `alterTable()`.
- Implement the listener `private onEngineSchemaChange = (event: SchemaChangeEvent)
  => void`: handle only `event.type === 'table_modified'`; when the table is
  connected, `table.updateSchema(event.newObject)`; append the read-compare-write
  to `persistQueue` (catalog `get` → compare to `generateTableDDL(event.newObject)`
  → `put` only on difference); catch+log inside the chain.
- In `closeAll()`: run the unsub thunk, then `await this.persistQueue` (settled)
  before `provider.closeAll()`.

### Phase 2 — tests

- Add `packages/quereus-store/test/tag-persistence.spec.ts` covering the cases
  above (reuse the in-memory provider factory from `rehydrate-catalog.spec.ts`).
- Confirm SET TAGS SQL syntax against `test/logic/50-metadata-tags.sqllogic`
  (Phases 11–13 for table/column/constraint).

### Phase 3 — validate

- `yarn workspace @quereus/quereus-store build` then `yarn test` (root) — stream
  output (`2>&1 | tee /tmp/test.log; tail -n 80 /tmp/test.log`).
- `yarn workspace @quereus/quereus lint` if any quereus-side file is touched
  (single-quote globs on Windows).
- Update `docs/schema.md` (tag persistence) and/or the store README if they
  describe catalog persistence — note that catalog-only tag swaps now persist for
  store tables, and that view/MV/index tag persistence remains pending (link the
  two backlog tickets).
