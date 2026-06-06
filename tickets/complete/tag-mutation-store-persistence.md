description: Re-persist catalog-only metadata-tag swaps (table / column / named-constraint tags via `ALTER … SET TAGS` and the programmatic `setTableTags`/`setColumnTags`/`setConstraintTags`) for store-backed tables, by subscribing the store module to the engine's `table_modified` schema-change events and re-writing the table's catalog DDL. Implemented and reviewed — complete.
files:
  - packages/quereus-store/src/common/store-module.ts          # listener + subscription + persist helper + whenCatalogPersisted + closeAll drain
  - packages/quereus-store/test/tag-persistence.spec.ts         # spec (now 11 cases: +CHECK, +FK constraint tags added in review)
  - packages/quereus/src/index.ts                               # export SchemaChangeEvent / SchemaChangeListener / TableModifiedEvent (type)
  - packages/quereus/src/runtime/emit/alter-table.ts            # updated stale "does not re-persist" NOTE comment
  - docs/schema.md                                              # persistence note after the tag-setter table
  - packages/quereus-store/README.md                            # catalog-persistence note under Storage Architecture
----

# Complete: re-persist catalog-only tag swaps for store-backed tables

## What was built

`ALTER TABLE … SET TAGS` (table / column / named-constraint) and the programmatic
`setTableTags` / `setColumnTags` / `setConstraintTags` are **catalog-only**: the
SchemaManager setters swap the in-memory `TableSchema`, re-register it, and fire a
`table_modified` event via `commitTagUpdate`. They deliberately do **not** call
`module.alterTable`, so the generic store module previously never re-wrote its on-disk
catalog DDL — the tag change was lost on close → reopen → `rehydrateCatalog`.

Fix: **`StoreModule` subscribes to the engine `SchemaChangeNotifier`** and, on each
`table_modified`, does a serialized read-compare-write of the table's catalog DDL
(absent → skip; identical DDL → skip; different → `put`). Subscription is lazy
(`ensureSchemaSubscription` from `create`/`connect`/`alterTable`), drained by `closeAll`
and the public `whenCatalogPersisted()` barrier, and detached on `closeAll`.

See the implement-stage diff (`git show 4813906b`) for the full design rationale.

## Review findings

Adversarial pass over commit `4813906b`. Read the diff first, then traced every event
path and helper. **No correctness bugs found; one coverage gap fixed inline.** Build +
lint + store suite all green.

### Checked — and what was verified

- **Event plumbing (SPP / correctness).** All three SET TAGS emit functions
  (`runSetTableTags` / `runSetColumnTags` / `runSetConstraintTags`) route through the
  SchemaManager setters, and all three setters call `commitTagUpdate`, which fires
  `table_modified`. So the single `table_modified` listener genuinely covers table,
  column, AND named-constraint tags. ✓
- **Key consistency.** The listener's `buildCatalogKey(schema, name)` lowercases
  identically to `saveTableDDL`'s key, so the read-compare-write targets the exact
  catalog entry the module itself writes. ✓
- **DDL determinism / no-clobber.** Listener and `saveTableDDL` both serialize via
  `generateTableDDL`, which emits `WITH TAGS (...)` for table, column, CHECK, UNIQUE,
  and FK (ddl-generator.ts lines 88/115/164/168/195). So the identical-DDL skip is
  exact, and a tag swap round-trips losslessly. ✓
- **Ordering vs structural ALTER (no double-write).** Every structural emit path awaits
  `module.alterTable` (which writes the final DDL via `saveTableDDL`) **before** the
  synchronous `notifyChange`. By the time the listener's queued read runs, the catalog
  already holds the module's final DDL → identical → skip. Confirmed by the existing
  put-count test (ADD COLUMN → exactly one write). ✓
- **Subscription hygiene.** `ensureSchemaSubscription` is idempotent (guards on
  `schemaListenerUnsub`); `onEngineSchemaChange` is a bound arrow property so its
  identity is stable for `removeListener`; `closeAll` unsubscribes **before** draining
  so no event enqueues mid-close. The "different db" branch logs and keeps the existing
  sub. ✓
- **Isolation wrapping.** Confirmed by code-read that `IsolationModule.create` /
  `connect` / `alterTable` forward the real `db` to `this.underlying.*` (isolation-
  module.ts 438/471/653), so the wrapped `StoreModule` still subscribes. Independently,
  the catalog-**absent** skip makes the listener robust regardless of `vtabModule`
  identity, so wrapping cannot cause a wrong/missing persist. ✓
- **Multi-module / memory-table self-filter.** The catalog-absent skip means a
  `table_modified` for a memory table (or another module's table) in the same `db`
  writes nothing to this provider's catalog — verified by the mixed-module test. ✓
- **Cache consistency.** `connected.updateSchema(newObject)` keeps a connected
  `StoreTable`'s cached schema current so a later lazy `saveTableDDL` (store-table.ts
  366, fired on first store access) can't re-write tag-less DDL. The store's UNIQUE
  enforcement reads `uniqueConstraints` from this cache; SET TAGS preserves the
  constraint shape, and addColumn (the only structural path that re-runs updateSchema
  via the listener) adds no UNIQUE, so enforcement is unaffected. ✓
- **Error handling / resource cleanup.** Each persist link `.catch`es + logs, mirroring
  `notifyChange`'s own try/catch — a listener rejection never escapes and never wedges
  the chain (the next link starts from a resolved promise). The global FIFO queue
  preserves per-key ordering (clear-after-set test). ✓

### Found & fixed (minor — fixed in this pass)

- **CHECK and FK constraint-class tags were untested** — only UNIQUE was covered, and
  the handoff explicitly flagged this. Added two reopen cases to
  `tag-persistence.spec.ts`: `named CHECK constraint tags persist across reopen` (also
  asserts the CHECK still enforces after reopen) and `named FOREIGN KEY constraint tags
  persist across reopen`. Both pass — the path is identical to UNIQUE
  (`resolveNamedConstraintClass` → `commitTagUpdate` → `table_modified`, and
  `generateTableDDL` serializes all three constraint classes' tags). Spec now **11
  passing**.

### Noted — acceptable, no action (with reasons)

- **InMemory test provider only.** The spec never drives a real LevelDB/IndexedDB
  provider, and `yarn test:store` doesn't exercise SET-TAGS reopen. Acceptable: the
  async-queue drain is provider-agnostic (it awaits `KVStore.get`/`put` returned by
  whichever provider is wired), and the LevelDB store path is exercised broadly
  elsewhere. Cross-provider durability of *this specific* drain remains a thin gap, not
  a defect.
- **`connected.updateSchema(newObject)` on a structural ALTER** swaps the `StoreTable`
  cache to the engine's enhanced (merged-constraint) schema rather than the module's
  column-only one. Reviewed: the store enforces CHECK/FK via the engine plan, not its
  cached copy; UNIQUE (the one constraint class the cache *is* read for) is unchanged by
  addColumn; and DDL is byte-identical (no-double-write test). Harmless.
- **Never-persisted store table** (SET TAGS before any store access) hits the
  catalog-absent skip — but the listener's `updateSchema` still tags the live cache, so
  the first store access's lazy `saveTableDDL` persists the tags anyway. The handoff's
  "tags are not persisted" note is *pessimistic*, not a bug; either way the outcome is
  consistent (tags persist iff the table persists).
- **Listener detached only on `closeAll`.** A consumer that drops a `Database` without
  calling `module.closeAll()` leaks the listener — but that's the same lifecycle
  contract the provider already requires (`closeAll` is the documented teardown). No
  regression.

### Out of scope → already-filed backlog (verified present, correctly deferred)

- **Index tags** (`setIndexTags` / `ALTER INDEX … SET TAGS`): fire `table_modified` but
  `generateTableDDL` doesn't serialize indexes and the store persists no `CREATE INDEX`
  DDL → identical table DDL → skipped (no harm). → `tickets/backlog/
  store-secondary-index-persistence.md`.
- **View / MV tags**: fire `view_modified` / `materialized_view_modified` (not
  `table_modified`) and the store persists no view/MV DDL → nothing to update. →
  `tickets/backlog/store-view-mv-persistence.md`.

Both backlog tickets exist and reference this work; no new tickets needed.

## Validation at completion

```
yarn workspace @quereus/quereus build          # clean
yarn workspace @quereus/store   build          # clean
yarn workspace @quereus/store   test           # 315 passing (313 baseline + 2 new)
yarn workspace @quereus/quereus lint           # clean (exit 0)
```

The "boom" / "THIS IS NOT VALID SQL" / rehydrate-skip log lines in the store-suite
output are from **pre-existing intentional negative tests**, not failures. No
`.pre-existing-error.md` written — nothing failed.
