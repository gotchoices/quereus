description: Store-backed tables do not re-persist a catalog-only metadata-tag change (`ALTER … SET TAGS`, or the programmatic `SchemaManager.setTableTags/setColumnTags/setConstraintTags`) across reconnect, because the store persists DDL only from its `module.alterTable` hook, which tag-only swaps deliberately bypass.
files:
  - packages/quereus-store/src/common/store-module.ts  # alterTable / saveTableDDL — persistence is keyed off alterTable
  - packages/quereus/src/schema/manager.ts             # commitTagUpdate fires table_modified (catalog-only)
  - packages/quereus/src/runtime/emit/alter-table.ts   # runSetTableTags/runSetColumnTags/runSetConstraintTags
  - packages/quereus/src/schema/change-events.ts        # SchemaChangeNotifier (table_modified)
----

# Re-persist catalog-only tag swaps for store-backed tables

## Why

`10-alter-table-tag-mutation` made `ALTER TABLE … SET TAGS` (and the programmatic
`setColumnTags` / `setConstraintTags`, plus the pre-existing `setTableTags`) a
**catalog-only** mutation: it swaps the in-memory `TableSchema`, re-registers it,
and fires a `table_modified` change event — it does **not** call
`module.alterTable`. That is correct by design (tags touch no stored row or
physical layout, and it lets `SET TAGS` succeed even on modules without an
`alterTable` hook).

The LevelDB / generic store module (`@quereus/quereus-store`) re-serializes a
table's DDL via `saveTableDDL(...)` **only from inside `module.alterTable`** (and
at create time). Because a tag-only swap never reaches `alterTable`, the store's
on-disk catalog DDL is not refreshed — so a tag set / change / clear made via
`SET TAGS` is lost when the store is closed and reopened. `generateTableDDL`
*does* serialize `WITH TAGS`, so the gap is purely "nothing triggers the
re-write", not "tags aren't serializable".

This is a pre-existing latent gap for the programmatic `setTableTags` too; the new
SQL surface just makes it reachable from SQL.

## Options

- **Subscribe the store to `table_modified`.** Register a `SchemaChangeNotifier`
  listener in the store module that calls `saveTableDDL(newObject)` on a
  `table_modified` whose `newObject` differs only in tags (or unconditionally —
  re-serializing DDL on any catalog swap is cheap and idempotent). This is the
  general fix and also covers any future catalog-only mutation.
- **Lightweight persist hook.** Add an optional `persistSchema?(db, schema)` (or
  reuse `saveTableDDL`) the engine calls after a catalog-only tag swap when the
  module advertises it. Narrower, but couples the engine to a store concept.

Prefer the change-event subscription — it keeps the engine's catalog-only
contract intact and the store owns its own persistence.

## Acceptance

- Set/change/clear tags via `ALTER … SET TAGS` on a store-backed table, close the
  database, reopen it against the same store, and the tags round-trip (table /
  column / named-constraint) through the introspection TVFs.
- Add a `yarn test:store` case (the memory path is already covered by
  `test/logic/50-metadata-tags.sqllogic`).
- No double-persist or recursion when the store's own `alterTable` already saved
  the DDL (guard against the `table_modified` it may itself trigger).
