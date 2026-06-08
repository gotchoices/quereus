description: Persist views and materialized views in the generic store module's `__catalog__` and rehydrate them on reopen. Subscribe the store's `SchemaChangeNotifier` listener to view/MV lifecycle + tag events (writing/removing prefixed catalog entries via the new engine `generateViewDDL`/`generateMaterializedViewDDL`), and phase rehydration tables → views → materialized views (tables via `importCatalog` connect; views via `importCatalog` silent register; MVs re-materialized via `db.exec`). Brings `CREATE/DROP VIEW`, `CREATE/DROP MATERIALIZED VIEW`, and `ALTER VIEW|MATERIALIZED VIEW … SET TAGS` to durable parity with tables.
prereq: view-mv-persistence-engine-support
files:
  - packages/quereus-store/src/common/store-module.ts          # onEngineSchemaChange + save/remove view&MV DDL + rehydrateCatalog phasing + RehydrationResult
  - packages/quereus-store/src/common/key-builder.ts           # buildViewCatalogKey / buildMaterializedViewCatalogKey + classify helper
  - packages/quereus-store/test/rehydrate-catalog.spec.ts      # reopen round-trip cases (or a new view-mv-persistence.spec.ts)
  - packages/quereus-store/test/tag-persistence.spec.ts        # view/MV SET/ADD/DROP TAGS reopen round-trip
  - docs/schema.md                                             # persistence note: views/MVs now durable
  - packages/quereus-store/README.md                           # catalog architecture: view/MV key namespaces
----

# Persist views and materialized views for store-backed databases

## Why / current state

The store module persists only table DDL (bundled with secondary indexes),
keyed `{schema}.{table}` in the `__catalog__` store. Views and materialized
views are engine-level catalog objects that never pass through a vtab module
hook, so they are lost on close → reopen, and `ALTER VIEW|MATERIALIZED VIEW …
SET TAGS` tags cannot round-trip.

Resolved during planning:

- **MV backing tables are always `memory`-module** (`buildBackingTableSchema`
  hardcodes `memory`; v1 MV backing is mem-only). They are **never** store-backed
  and **never** persisted → there is **no dangling backing on reopen**. An MV
  must be re-materialized from its body on reopen (the create path rebuilds the
  memory backing from current source data).
- Plain `CREATE/DROP VIEW` now fire `view_added`/`view_removed` (sibling engine
  ticket). MVs already fire `materialized_view_added`/`_removed`/`_modified`/
  `_refreshed`. The store subscribes to all of these.
- `generateViewDDL` / `generateMaterializedViewDDL` (engine ticket) serialize a
  schema (with current tags) to re-parseable DDL.

This ticket is store-package only and depends on the engine ticket landing.

## Design

### Catalog key namespaces

Table entries keep their existing unprefixed key `{schema}.{table}` (do not
re-key — preserves existing persisted catalogs and the table full-scan). Views
and MVs get **reserved-prefix** keys so they never collide with a same-named
table entry (a view and a table may share a name; do not assume disjointness):

```
view key  =  encode(VIEW_PREFIX  + `{schema}.{view}`)     // e.g. "\x00view\x00main.v"
mv key    =  encode(MVIEW_PREFIX + `{schema}.{mv}`)        // e.g. "\x00mview\x00main.mv"
```

Add `buildViewCatalogKey(schema, name)` / `buildMaterializedViewCatalogKey(
schema, name)` to `key-builder.ts`. Pick prefix bytes that (a) are valid KV key
bytes for every provider (a leading `0x00` byte is fine for the in-memory,
LevelDB, and IndexedDB stores — all accept arbitrary `Uint8Array` keys) and (b)
let rehydrate **classify** each loaded entry by kind. The existing
`buildCatalogScanBounds()` is a full range scan and WILL return the prefixed
view/MV entries alongside table entries — that is fine: rehydrate classifies
every loaded entry by its key prefix and routes it to the correct phase (a
view/MV entry must never be fed to the table-phase `importCatalog`, which would
fail-loud or mis-handle it). Document the chosen prefix bytes and the
classification rule in `key-builder.ts`.

### Incremental persistence (the listener)

Extend `onEngineSchemaChange` (today it handles `table_modified` only). All new
writes ride the existing serialized `persistQueue` (drained by `closeAll` /
`whenCatalogPersisted`) exactly like the table path — `notifyChange` is
synchronous and does not await listeners:

| event                          | action                                                            |
|--------------------------------|-------------------------------------------------------------------|
| `view_added`                   | `put` view entry = `generateViewDDL(newObject)`                   |
| `view_removed`                 | `delete` view entry                                              |
| `view_modified`                | regenerate `generateViewDDL(newObject)` + compare + `put`        |
| `materialized_view_added`      | `put` MV entry = `generateMaterializedViewDDL(newObject)`        |
| `materialized_view_removed`    | `delete` MV entry                                               |
| `materialized_view_modified`   | regenerate `generateMaterializedViewDDL(newObject)` + compare + `put` |
| `materialized_view_refreshed`  | regenerate + compare + `put` (DDL usually unchanged → skip)      |

- Unlike the table path there is **no catalog-absent self-filter** for added/
  removed — one `StoreModule` instance serves one `Database`, and that database's
  views/MVs belong in its store catalog. For `*_modified`/`*_refreshed` keep the
  regenerate-compare-write (skip identical) to avoid redundant writes (this is
  what makes a rehydrate-time MV re-add idempotent — see below).
- The MV **backing table** (`_mv_<name>`, memory module) fires `table_added`/
  `table_removed`/`table_modified`. The store must continue to **ignore** these
  (it does today: `table_added`/`table_removed` aren't handled, and
  `table_modified` is catalog-absent for a memory table → skipped). Confirm the
  new MV handling does not accidentally persist the backing.

### Subscription lifetime

`ensureSchemaSubscription` is currently lazy off the first `create`/`connect`/
`alterTable` table hook. A store-backed DB that creates a view/MV **before any
store table** would miss the event. Establish the subscription in
`rehydrateCatalog(db)` (it has `db`) so any reopened DB is subscribed up front,
and (defensive) document that a brand-new DB whose very first DDL is a view
relies on a prior store-table create for the subscription — if that gap matters,
expose/`ensureSchemaSubscription` from an explicit attach point. Enumerate this
in tests.

### Rehydration phasing

`rehydrateCatalog` must import in dependency order. Load all entries once
(full scan), classify by key prefix into `{tables, views, mvs}`, then:

1. **Tables** — `importCatalog(tableBundles)` as today (connects to existing
   storage; also refreshes connected `StoreTable` schemas).
2. **Views** — `importCatalog(viewDDLs)` (engine silent-register path). Order
   among views does **not** matter (no body planning at import; validation is
   deferred to query time), so view-over-view and view-over-MV both work.
3. **Materialized views** — re-materialize via `db.exec(mvDDL)` **per entry**,
   which re-runs the create emitter: rebuilds the memory backing from current
   source data, re-registers row-time maintenance, and re-runs the eligibility
   gate. Sources are present (tables connected in phase 1; views registered in
   phase 2). Wrap each `exec` in try/catch and record failures in the result
   (mirror the per-entry error collection the table path already does) so one bad
   MV doesn't abort the rest.
   - **Ordering for MV-over-MV:** an MV whose body reads another MV resolves to
     that MV's backing table (`_mv_<x>`), which appears in `sourceTables`.
     Topologically order the phase-3 execs so a dependency MV is materialized
     before its dependent (compare each pending MV's `sourceTables` against the
     other pending MVs' `backingTableNameFor(name)`). On an unresolvable cycle
     (should not happen) fall back to declared order and let the per-entry error
     collection record the failure. If full topo proves heavy, the common
     single-level case (MVs over base tables/views) must still work; deeper
     nesting hardening may be deferred to the backlog ticket
     `store-mv-rehydrate-via-importcatalog` — document whichever you choose.

Re-execing an MV at rehydrate re-fires `materialized_view_added` → the listener
regenerates `generateMaterializedViewDDL` → identical to the stored entry →
compare-skip (no churn). The view silent-import fires **no** event, so phase 2
writes nothing. Verify both.

Extend `RehydrationResult` with `views: string[]` and `materializedViews:
string[]` (additive; `quoomb-web` only reads `.errors`). Errors from any phase
go in the existing `errors` array.

## Edge cases & interactions

- **Table/view name collision** in one schema: distinct key prefixes must keep
  their catalog entries independent (no overwrite). Test a table `foo` + view
  `foo`.
- **Classification correctness**: the full-range catalog scan returns prefixed
  view/MV entries; none may be routed into the table-phase `importCatalog`.
  Round-trip a DB with tables + views + MVs and assert all three rehydrate.
- **View tag round-trip**: `ALTER VIEW v SET/ADD/DROP TAGS` then
  `whenCatalogPersisted()` → reopen → `schema()`/view tags match. Same for
  `ALTER MATERIALIZED VIEW`.
- **DROP durability**: `DROP VIEW` / `DROP MATERIALIZED VIEW` then reopen → the
  object (and, for the MV, its backing) is gone; the catalog entry is deleted.
- **MV row-time maintenance after reopen**: create MV over a store table, reopen,
  `insert`/`update`/`delete` on the source → the rehydrated MV reflects the
  change (proves maintenance was re-registered, not just the snapshot rebuilt).
- **MV over a memory (non-persisted) source**: on reopen the source is absent →
  the phase-3 `exec` throws → recorded in `errors`, MV not registered. Document
  as an inherent limitation of mixing memory sources into a durable catalog (same
  for a plain view over a memory table — it silently registers but errors at
  query time). Not a defect of this ticket.
- **View over MV / view over view**: silent register defers validation, so both
  rehydrate regardless of order; assert queryable after reopen.
- **Persist-queue drain**: view/MV writes must enqueue on `persistQueue` (not
  write inline) so `closeAll`/`whenCatalogPersisted` flush them before the
  provider closes. Add a put-count / drain assertion.
- **Subscription-before-first-table**: a reopened DB is subscribed via
  `rehydrateCatalog`; cover the create-view-after-reopen persistence path.
- **Idempotent rehydrate**: re-materializing MVs must not churn the catalog
  (compare-skip); a second consecutive reopen yields identical catalog bytes.
- **Refreshed event**: `REFRESH MATERIALIZED VIEW` then `whenCatalogPersisted`
  must not corrupt the entry (DDL unchanged → skip).

## TODO

- Add `buildViewCatalogKey` / `buildMaterializedViewCatalogKey` + a key-prefix
  classify helper to `key-builder.ts`; document the prefix bytes and the
  full-scan/classification interaction.
- Add `saveViewDDL` / `removeViewDDL` / `saveMaterializedViewDDL` /
  `removeMaterializedViewDDL` (build entries via the engine generators).
- Extend `onEngineSchemaChange` to handle the seven view/MV events per the table
  above, all serialized on `persistQueue`; keep ignoring backing-table events.
- Establish the subscription in `rehydrateCatalog(db)`.
- Rewrite `rehydrateCatalog` to load-all → classify by prefix → phase
  tables(importCatalog) → views(importCatalog) → MVs(`db.exec`, dependency-
  ordered) with per-entry error collection.
- Extend `RehydrationResult` with `views` / `materializedViews`.
- Docs: `docs/schema.md` persistence note; `packages/quereus-store/README.md`
  catalog architecture (view/MV key namespaces + rehydrate phasing).
- Tests (store; extend `rehydrate-catalog.spec.ts` + `tag-persistence.spec.ts`,
  or add `view-mv-persistence.spec.ts`) covering the Edge cases above:
  plain view reopen; view tags SET/ADD/DROP round-trip; DROP VIEW durable; MV
  reopen (backing rebuilt + maintenance live); MV tags round-trip; DROP MV
  durable (MV + backing gone); table/view name collision; view-over-MV and
  view-over-view; MV-over-store-table and (if implemented) MV-over-MV ordering;
  persist-queue drain; idempotent second reopen.
- `yarn workspace @quereus/store build`, `… test`, and
  `yarn workspace @quereus/quereus lint` green. Note in the handoff whether
  `yarn test:store` (LevelDB path) was run for the new reopen cases or deferred
  (the existing tag-persistence spec uses an in-memory provider).
