description: Re-persist catalog-only metadata-tag swaps (table / column / named-constraint tags via `ALTER … SET TAGS` and the programmatic `setTableTags`/`setColumnTags`/`setConstraintTags`) for store-backed tables, by subscribing the store module to the engine's `table_modified` schema-change events and re-writing the table's catalog DDL. Implemented; needs an adversarial review pass.
files:
  - packages/quereus-store/src/common/store-module.ts          # listener + subscription + persist helper + whenCatalogPersisted + closeAll drain
  - packages/quereus-store/test/tag-persistence.spec.ts         # new spec (9 cases), persistent in-memory provider
  - packages/quereus/src/index.ts                               # export SchemaChangeEvent / SchemaChangeListener / TableModifiedEvent (type)
  - packages/quereus/src/runtime/emit/alter-table.ts            # updated stale "does not re-persist" NOTE comment
  - docs/schema.md                                              # persistence note after the tag-setter table
  - packages/quereus-store/README.md                            # catalog-persistence note under Storage Architecture
----

# Review: re-persist catalog-only tag swaps for store-backed tables

## What was built

`ALTER TABLE … SET TAGS` (table / column / named-constraint) and the programmatic
`setTableTags` / `setColumnTags` / `setConstraintTags` are **catalog-only**: the
SchemaManager setters swap the in-memory `TableSchema`, re-register it, and fire a
`table_modified` event via `commitTagUpdate`. They deliberately do **not** call
`module.alterTable`, so the generic store module never re-wrote its on-disk catalog
DDL — the tag change was lost on close → reopen → `rehydrateCatalog`.

Fix: **`StoreModule` now subscribes to the engine `SchemaChangeNotifier`** and, on
each `table_modified`, does a read-compare-write of the table's catalog DDL.

Implementation (all in `store-module.ts`):

- **Lazy subscription** — `ensureSchemaSubscription(db)` is called at the top of
  `create()`, `connect()`, and `alterTable()` (the three hooks that receive a `db`);
  subscribes exactly once, records the unsubscribe thunk + `subscribedDb`, and logs
  (keeps the existing sub) if a *different* `db` ever arrives. Verified that
  `IsolationModule.create/connect` delegate the real `db` to the underlying
  `StoreModule`, so the subscription fires under isolation wrapping.
- **Listener** (`onEngineSchemaChange`) — handles `table_modified` **only**; ignores
  every other event type. When the table is currently connected it also calls
  `table.updateSchema(event.newObject)` (SET TAGS doesn't, so the cache would go
  stale). It appends the persist to a serialized `persistQueue` and swallows+logs
  errors inside the chain (mirrors `notifyChange`'s own try/catch — a listener
  rejection must never escape).
- **Persist rule** (`persistCatalogIfChanged`) — `catalogStore.get(key)`:
  **absent** → skip (self-filters memory tables / never-persisted store tables
  without relying on `vtabModule` identity, which points at the isolation wrapper
  when wrapped); **present + identical DDL** → skip (this is what makes a structural
  ALTER, whose own `alterTable` already wrote the final DDL, a no-op here — no
  double-write); **present + different DDL** → `put`.
- **Drain** — `closeAll()` runs the unsubscribe thunk, then `await persistQueue`,
  before `provider.closeAll()`. A public `whenCatalogPersisted()` barrier exposes the
  same drain without a full close (durability hook; used by tests).
- **Engine export** — `SchemaChangeEvent` (+ `SchemaChangeListener`,
  `TableModifiedEvent`) are now exported from `@quereus/quereus` so the store can type
  the listener.

## Why the single read-compare-write is correct on every path

- **Tag-only swap** (in scope): catalog still holds the *old* DDL → differs →
  persisted. A clear (`SET TAGS ()`) drops the `WITH TAGS` clause → also differs →
  persisted (round-trips to "no tags").
- **Structural ALTER** (addColumn/dropColumn/rename*/alterColumn/alterPrimaryKey/
  add|drop|renameConstraint): the store's own `alterTable` already wrote the final
  DDL, and the engine then fires `table_modified` with the same final registered
  schema. For addColumn-with-column-level-CHECK/FK, the engine's `enhancedTableSchema`
  merges the same constraints (resolved to the same new-column index) that the store's
  `persistedSchema` does → `generateTableDDL` byte-identical → skip. **Verified by a
  put-count test.**
- **No recursion** — `saveTableDDL` / the listener's `put` write only the KV catalog
  store; they fire no engine event.
- **Beneficial side effects (intended, kept)** — engine-direct `ADD CHECK` (which
  bypasses `module.alterTable`) and propagated column/table-rename rewrites of
  *dependent* store tables now also persist via this listener (catalog present, DDL
  differs). Documented; not separately tested.

## How to validate

Build + run (store spec runs under the default `yarn test`; quereus-store workspace
is `@quereus/store`):

```
yarn workspace @quereus/store build
node --import ./packages/quereus-store/register.mjs node_modules/mocha/bin/mocha.js \
  "packages/quereus-store/test/tag-persistence.spec.ts" --reporter spec
# or the whole suite:
yarn test
```

Status at handoff: **`yarn test` = 5797 passing, 0 failing** (incl. the 9 new cases);
`yarn workspace @quereus/store test` = 313 passing; `yarn workspace @quereus/quereus
lint` clean. The "boom" / "THIS IS NOT VALID SQL" / "[Sync] Error handling …" log
lines in the output are from **pre-existing intentional negative tests**, not failures.

### New spec cases (`tag-persistence.spec.ts`)

Two-phase (db1 creates over a shared persistent in-memory provider; db2 + fresh
`StoreModule` rehydrates the same provider — the only way to express close→reopen):

1. **Table tags** persist across reopen (via `closeAll` drain) — `getTableTags` deep-equals.
2. **Column tags** persist — `findTable().columns[].tags`.
3. **Named UNIQUE constraint tags** persist AND the UNIQUE still enforces after reopen.
4. **Clear** (`SET TAGS ()`) round-trips to `undefined`; also exercises **ordering**
   (two swaps serialize; final state = cleared).
5. **Change** (set, re-set different, reopen) → latest value.
6. **Persists without explicit close** via `whenCatalogPersisted()`; also asserts the
   in-session value is already live.
7. **Mixed-module isolation** — SET TAGS on a `memory` table in the same db writes
   **no** store catalog entry; the store table's entry is present.
8. **No structural double-write** — a put-spy shows `ADD COLUMN` persists exactly once
   (module), the listener skips the identical-DDL `table_modified`; column set
   round-trips.
9. **Unsubscribe on close** — after `closeAll`, a later `table_modified` (fired by
   `setTableTags` on the still-registered engine schema) does **not** re-persist.

The memory path for SET TAGS itself is already covered by
`packages/quereus/test/logic/50-metadata-tags.sqllogic` (Phases 11–13).

## Known gaps / things to scrutinize (treat tests as a floor)

- **CHECK / FK constraint tags** are not separately tested — only **UNIQUE**. The path
  is identical (`resolveNamedConstraintClass` → `commitTagUpdate` → `table_modified`,
  and `generateTableDDL` serializes all three constraint classes' tags), so risk is
  low, but a reviewer adding CHECK + FK reopen cases would close the coverage.
- **InMemory provider only.** The spec never exercises a real `LevelDB`/`IndexedDB`
  provider; `yarn test:store` re-runs quereus *logic* tests against LevelDB but those
  don't cover SET TAGS reopen. Cross-platform durability of the async-queue drain on a
  real provider is unverified here.
- **Isolation wrapping is reasoned, not tested.** I confirmed by code-read that
  `IsolationModule` forwards `db`, but no test runs tag persistence through an
  `IsolationModule`. Worth a direct test.
- **`connected.updateSchema(newObject)` on a structural ALTER** overwrites the
  `StoreTable`'s cached schema with the engine's *enhanced* (merged-constraint) schema
  rather than the module's column-only one. Argued harmless (the store enforces
  CHECK/FK via the engine plan / registered schema, not its cached copy; UNIQUE
  full-scan is unaffected since addColumn adds no UNIQUE; DDL is identical — confirmed
  by the no-double-write test). A reviewer should confirm no store write path reads
  CHECK/FK from the `StoreTable` cache.
- **Never-persisted store table** — SET TAGS before any store access hits the
  catalog-absent skip, so tags are not persisted (consistent with the table itself not
  persisting; the spec INSERTs first, as documented). Not separately asserted.
- **Queue is global, not per-key.** All keys serialize through one `persistQueue`.
  Correct (FIFO preserves per-key order) and simple, but heavy concurrent ALTER load
  across many tables is not stress-tested.

## Out of scope → already-filed backlog (genuinely blocked)

- **Index tags** (`setIndexTags` / `ALTER INDEX … SET TAGS`): fires `table_modified`
  but `generateTableDDL` does not serialize indexes and the store never persists
  `CREATE INDEX` DDL, so an index-tag event yields identical table DDL → skipped (no
  harm). → `tickets/backlog/store-secondary-index-persistence.md` (already notes this
  as a follow-on).
- **View / MV tags**: fire `view_modified` / `materialized_view_modified` (not
  `table_modified`) and the store persists no view/MV DDL at all → nothing to update.
  → `tickets/backlog/store-view-mv-persistence.md` (already notes the follow-on).

Both backlog tickets pre-existed and already reference this ticket; no new tickets needed.
