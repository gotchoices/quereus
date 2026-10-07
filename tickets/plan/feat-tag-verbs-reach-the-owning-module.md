description: Changing tags with `alter table … set / add / drop tags` (on the table, a column, or a named constraint) only edits the engine's in-memory catalog and never tells the table's storage module, so a module that keeps its own durable copy of the table definition cannot save the change and cannot refuse it. Add an awaited module hook for tag edits, keeping today's catalog-only behavior for modules that do not implement it.
architecture: docs/module-authoring-schema-changes.md
files:
  - packages/quereus/src/runtime/emit/alter-table.ts        # runSet/Merge/Drop{Table,Column,Constraint}Tags — catalog-only today; the dispatch point
  - packages/quereus/src/schema/manager.ts                 # updateTableTags / updateColumnTags / updateConstraintTags / commitTagUpdate (fires `table_modified`)
  - packages/quereus/src/vtab/module.ts                    # VirtualTableModule — where the new optional hook (or SchemaChangeInfo arm) is declared
  - packages/quereus-isolation/src/isolation-module.ts     # must forward the hook to the underlying module (tag-only: no overlay migration)
  - packages/quereus-store/src/common/store-module-schema-sync.ts  # store recovers tag edits from `table_modified` today; may switch to the hook, or stay as is
  - docs/module-authoring-schema-changes.md
  - docs/sql-alter.md                                      # § SET TAGS / ADD TAGS / DROP TAGS — the "Catalog-only … none of these round-trips through the module's `alterTable`" bullet
----

Filed from the lamina board (lamina slug `bug-engine-side-set-tags-never-reaches-lamina-schema`). The lamina side that consumes this is lamina's `tickets/blocked/wire-engine-tag-verbs-into-lamina-alter-table.md`; it lands after this ships in a published `@quereus/quereus` (and `@quereus/isolation`) release.

## What happens today

Measured against published `@quereus/quereus` 4.20.2. `runtime/emit/alter-table.ts` dispatches the `setTags` / `dropTags` actions to `runSetTableTags`, `runMergeTableTags`, `runDropTableTags` and the column / constraint variants. Each calls the matching `SchemaManager` setter, which swaps the in-memory `TableSchema` and fires `table_modified`. None of them calls the module. The comment above `runSetTableTags` says so on purpose, and the generic store module recovers the edit by listening for `table_modified` and rewriting its catalog DDL.

That listener route does not work for a module that keeps its own durable table definition and wants the edit to behave like every other ALTER:

- `SchemaChangeNotifier.notifyChange` catches and logs listener throws, so the module cannot fail the statement when it cannot persist, or when it must refuse the edit.
- Listeners are synchronous; a durable schema write is async.
- The module cannot tell its own re-publishes of a schema (which also fire `table_modified`) from user tag edits without extra bookkeeping.

Lamina is such a module. It persists table, column, UNIQUE and FOREIGN KEY tags in its own stored schema, re-projects that schema to the engine on every `create` / `connect` / `alterTable`, and gives some column tag keys (`monotonic`, `counted`, `orderCodec`) storage meaning. Today an engine-side tag edit on a lamina table is lost on reopen, and a tag edit that would silently change a column's storage behavior cannot be refused.

## Requested behavior

When the owning module opts in, a tag verb on a table, column or named constraint calls the module before the catalog changes:

- The call is **awaited**. If it throws, the statement fails with that error and the catalog is unchanged.
- The engine **registers the schema the module returns**, exactly as every `alterTable` arm does today, then fires `table_modified` as it does now (optimizer caches still invalidate).
- Plan-time and pre-mutation validation stays engine-side and runs **before** the call: reserved `quereus.*` key validation, unknown column / constraint (`NOTFOUND`), and `DROP TAGS` of an absent key (`NOTFOUND`, atomic). The module sees only edits the engine would have applied.
- The payload carries what the user wrote, not only the result: the target (`table`, `column` + column name, or `constraint` + constraint name), the mode (`replace` for SET, `merge` for ADD, `drop` for DROP), and the tags (replace / merge) or keys (drop). The module computes the result against its own stored view; the engine's live view may hold keys the module itself stamped at projection time (lamina stamps a derived `quereus.id`).
- The `ddl` emit-iff-set rule applies the same way as for `alterTable` arms: set on the call that is the statement's action.
- `ddl_transaction_policy = 'strict'` is already asserted at the top of the ALTER emitter for every action, so nothing changes there.
- **Fallback unchanged:** a module that does not opt in keeps today's catalog-only path, including the store module's `table_modified` recovery.
- `@quereus/isolation`'s `IsolationModule` forwards the call to the underlying module when the underlying module opts in. A tag edit moves no row and changes no layout, so it must not run the overlay migration / poisoning machinery that `IsolationModule.alterTable` runs for structural arms.

## Shape: the decision this plan must make

Two shapes satisfy the behavior above. The lamina side is indifferent between them, since it maps either one onto its own internal clause.

- **Recommended: a separate optional hook**, e.g. `alterTags?(db, schemaName, tableName, change: TagChangeInfo): Promise<TableSchema>`, where `TagChangeInfo = { target: { kind: 'table' } | { kind: 'column'; columnName: string } | { kind: 'constraint'; constraintName: string }; ddl?: string } & ({ mode: 'replace' | 'merge'; tags: Record<string, SqlValue> } | { mode: 'drop'; keys: readonly string[] })`. Opt-in by presence, so the memory module, the store module and third-party modules that implement `alterTable` are untouched. No new arm is added to `SchemaChangeInfo`, so [SCH-004](../../docs/invariants.md) ("a module never silently no-ops an `alterTable` arm") gains no new obligation for existing modules.
- **Alternative: a new `SchemaChangeInfo` arm** routed through `alterTable` whenever the module implements `alterTable`. It reuses the existing hook, but every existing `alterTable` implementer (memory, store, isolation, third parties) must then handle the arm or the tag verbs start failing on them. That is more blast radius for a metadata-only edit.

Out of scope unless the plan finds it cheap to include: `alter index … set tags` (`runtime/emit/set-object-tags.ts`, also catalog-only today) could take the same hook with an `index` target for the module that owns the index's table. Lamina persists index tags too, so it would use one. View and materialized-view tag edits have their own path and are not requested.

## Tests

- A module that opts in sees one awaited call per tag statement with the payload above, and the catalog reflects the schema it returned.
- A module whose hook throws leaves the catalog unchanged and fails the statement with the module's error.
- A module that does not opt in keeps today's behavior (the existing tag-verb sqllogic coverage already pins this).
