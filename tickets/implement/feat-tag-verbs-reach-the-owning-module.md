description: Changing tags with `alter table … set / add / drop tags` (on the table, a column, or a named constraint) only edits the engine's in-memory catalog and never tells the table's storage module, so a module that keeps its own durable copy of the table definition cannot save the change and cannot refuse it. Add an awaited, optional module hook for tag edits, keeping today's catalog-only behavior for modules that do not implement it.
architecture: docs/module-authoring-schema-changes.md
files:
  - packages/quereus/src/vtab/module.ts                     # new optional `alterTags` hook, `TagChangeInfo` / `TagChangeTarget` types
  - packages/quereus/src/vtab/alter-event-shape.ts          # new `tagChangeEventShape`
  - packages/quereus/src/index.ts                           # export the new types (line ~62) and helper (line ~88)
  - packages/quereus/src/schema/manager.ts                  # split update{Table,Column,Constraint}Tags into compute + commit; new read-only preview method
  - packages/quereus/src/runtime/emit/alter-table.ts        # setTags / dropTags dispatch (~line 146), run*Tags helpers and their header comment (~line 1689)
  - packages/quereus/src/planner/nodes/alter-table-node.ts  # comments saying "No module round-trip"
  - packages/quereus/src/planner/building/alter-table.ts    # NOTE saying the tag arms never announce
  - packages/quereus-isolation/src/isolation-module.ts      # constructor forward (pattern at ~line 221)
  - packages/quereus/test/alter-table-schema-events.spec.ts # stale comment in the "deliberately silent" test (~line 362)
  - packages/quereus/test/vtab/alter-tags-hook.spec.ts      # new
  - packages/quereus-isolation/test/alter-tags-forwarding.spec.ts # new
  - docs/module-authoring-schema-changes.md
  - docs/module-capabilities.md
  - docs/sql-alter.md
  - docs/usage.md
  - docs/invariants.md
  - docs/schema-undo-plan.md
  - packages/quereus-isolation/README.md
----

Filed from the lamina board (lamina slug `bug-engine-side-set-tags-never-reaches-lamina-schema`). The lamina side that consumes this is lamina's `tickets/blocked/wire-engine-tag-verbs-into-lamina-alter-table.md`; it lands after this ships in a published `@quereus/quereus` (and `@quereus/isolation`) release.

## Why the existing channel is not enough

The nine tag statement forms (table, column or named constraint, by SET, ADD or DROP) go to `SchemaManager` setters that swap the in-memory `TableSchema` and fire `table_modified`. The generic store module recovers the edit by listening for that event. That route fails a module that keeps its own durable table definition: `SchemaChangeNotifier.notifyChange` catches and logs listener throws, so the module cannot fail the statement; listeners are synchronous while a durable write is async; and the module cannot tell its own schema re-publishes from user tag edits. Lamina is such a module, and it gives some column tag keys (`monotonic`, `counted`, `orderCodec`) storage meaning, so it also needs to refuse some edits.

## Design

### The hook

A separate optional hook, opted into by presence:

```typescript
export type TagChangeTarget =
	| { kind: 'table' }
	| { kind: 'column'; columnName: string }
	| { kind: 'constraint'; constraintName: string };

export type TagChangeInfo = { readonly target: TagChangeTarget; readonly ddl?: string } & (
	| { readonly mode: 'replace' | 'merge'; readonly tags: Readonly<Record<string, SqlValue>> }
	| { readonly mode: 'drop'; readonly keys: readonly string[] }
);

// on VirtualTableModule
alterTags?(db: Database, schemaName: string, tableName: string, change: TagChangeInfo): Promise<TableSchema>;
```

Chosen over a new `SchemaChangeInfo` arm. A new arm would make every existing `alterTable` implementer (memory, store, isolation, third parties) handle it or start failing tag verbs, and it would add an arm to the obligation in SCH-004 ("a module never silently no-ops an `alterTable` arm"). The hook leaves those modules untouched. The cost is one more method on the module surface.

`TagChangeInfo` carries what the user wrote (mode plus tags or keys), not the resulting set, because the module computes the result against its own stored view. The engine's live view may hold keys the module stamped at projection time (lamina stamps a derived `quereus.id`).

### Statement flow

In `emitAlterTable`, the `setTags` and `dropTags` cases call one new function, `runTagEdit(rctx, tableSchema, target, edit, plan.sql)`:

- **Module has no `alterTags`, or the edit is an empty ADD or DROP:** the existing catalog-only dispatch, unchanged. Move the mode and target dispatch from the `switch` into a helper; the nine `run*Tags` wrappers can stay.
- **Otherwise, in this order:**
  1. Call the new `SchemaManager` preview method (below), which reads the **live** table. It runs every check the setter would and returns the live schema plus the target with its **stored** spelling.
  2. `await module.alterTags(db, live.schemaName, live.name, { target: storedTarget, ...edit, ddl: sql })`. A throw propagates unchanged, with the catalog untouched and no `table_modified`.
  3. `withGeneratedColumnGraph(returned, buildColumnSourceResolver(rctx.db))`, then keep `statistics: returned.statistics ?? live.statistics`.
  4. `const registered = schema.addTable(...)`, then notify `table_modified` with `oldObject: live`, `newObject: registered`.
  5. `emitAlterSchemaEvent` using `tagChangeEventShape`.

The strict `ddl_transaction_policy` check and the maintained-table refusal already run at the top of the emitter, so they need no change.

### Decisions and their tradeoffs

- **Empty `ADD TAGS ()` and `DROP TAGS ()` do not call the hook.** The engine treats them as no-ops, so there is nothing to persist or refuse. They still take the catalog path, so an unknown target still raises `NOTFOUND`. `SET TAGS ()` is a real clear and does call the hook.
- **Target names are passed in their stored spelling.** `alter column V …` on column `v` arrives as `v`. `docs/module-authoring.md` already tells modules they may key by call arguments verbatim, and the engine has just resolved the name anyway. Tag keys stay verbatim, because they are case-sensitive.
- **The live schema is read at execution time, not taken from the plan-time `tableSchema`.** The setters already do this, so back-to-back ALTERs and prepared-statement reuse see the prior result. `DROP TAGS` validation must see it too.
- **The engine carries `statistics` when the module's return omits them.** A tag edit moves no value, so the measurements stay correct, and the catalog-only path preserves them today by spreading. Without this, a module that builds its return from its own stored view would discard ANALYZE results on every tag edit and could change query plans.
- **The generated-column graph is re-derived**, using the same call and for the same reason as the ADD COLUMN arm: a module's answer carries no such bookkeeping.
- **The hook path announces a public schema event; the catalog-only path stays silent.** `docs/usage.md` says tag arms report nothing because the engine derives no behavior from tags. That reason does not hold for a module that opted in, since lamina's column tags change storage behavior and a replicating peer must replay them. So an emitter-backed module emits iff `ddl` is set (the requested rule), and the engine's auto-event gate covers a module with no emitter, which keeps the usual "same event on either backend" property. The shape is `alter`/`column` with `columnName` for a column target and `alter`/`table` otherwise, matching how `drop constraint` reports. Built-in modules do not opt in, so their silence and the existing test stay as they are.
- **The store module stays on its `table_modified` listener.** It works, it is covered by `packages/quereus-store/test/tag-persistence.spec.ts`, and the store has no tag keys it must refuse. Moving it would add risk and no behavior.
- **The programmatic `SchemaManager.set*Tags` / `merge*Tags` / `drop*Tags` stay catalog-only.** They are synchronous, so they cannot await a module. Add a `NOTE:` to their TSDoc saying they bypass `alterTags`; if a caller outside tests and the emitter ever uses them on an opted-in table, they should refuse rather than lose the edit.
- **`alter index … set tags` is deferred** to `feat-index-tag-verbs-reach-the-owning-module` in the backlog. It is not cheap: it has a separate emitter outside the strict-policy check, must resolve the owning table from an index name, and has a store-mode fallback that routes tags onto a UNIQUE constraint's `exposedIndexTags`.

### SchemaManager changes

Split `updateTableTags`, `updateColumnTags` and `updateConstraintTags` each into a compute step that returns the swapped schema and mutates nothing, plus the existing `commitTagUpdate`. `resolveIndexTagSwap` / `updateIndexTags` is the existing pattern to mirror. Add one public read-only method that drives the same compute steps and discards the swap:

```typescript
previewTagEdit(
	tableName: string, target: TagChangeTarget,
	edit: { mode: 'replace' | 'merge'; tags: Record<string, SqlValue> } | { mode: 'drop'; keys: readonly string[] },
	schemaName: string,
): { live: TableSchema; target: TagChangeTarget };
```

This way the checks cannot drift from the setters.

### Isolation

`IsolationModule` assigns `alterTags` in its constructor only when the underlying module has it (the `getBackingHost` pattern at the top of the constructor), so presence mirrors the underlying and a store or memory underlying keeps the catalog-only path. The forward calls the underlying, sets `underlyingState.underlyingTable.tableSchema = updated` if a cached underlying exists (as `alterTable` does), and returns `updated`. It must not touch any overlay, run `deriveAlterMigrationPlan`, or poison anything: a tag edit moves no row and changes no layout.

## Edge cases & interactions

- **Unknown column or constraint, ambiguous constraint name, DROP of an absent key:** raised by the preview, before the hook, with the same code and message as today. Verify by test.
- **Reserved `quereus.*` key on SET or ADD:** raised at plan-build, so the hook is never reached. DROP of a reserved key stays legal and does reach the hook. Verify by inspection.
- **`null` tag value:** `ADD TAGS (k = null)` passes `{ k: null }`, distinct from a drop. Verify by the payload test.
- **Module throws:** catalog unchanged, no `table_modified`, no event, the module's error surfaces. Atomicity of anything the module already wrote is the module's duty; state it in the docs. Verify by test.
- **Module has a statement-level failure after the hook:** nothing fallible follows except the generated-graph derivation, which cannot fail when only tags changed. `withStatementScopedSchemaEvents` already retracts an emitter-backed module's event if something does. Verify by inspection.
- **Prepared statement re-run:** each run calls the hook once and re-validates against the live schema. Verify by inspection (the preview reads live).
- **Maintained table:** refused at the top of the emitter before dispatch, so the hook is never reached. Verify by inspection.
- **`apply schema`:** the differ's tag drift runs as ordinary `SET TAGS` statements, so the hook is called in `replace` mode inside the module's schema batch. The undo journal's restoring `SET TAGS` also calls the hook, so a hook that refuses during an unwind is reported as *undo statement `Y` failed*. A module must therefore accept a restoring edit it accepted before. Document in `docs/schema-undo-plan.md`; verify by inspection.
- **Explicit transaction with `rollback`:** a tag edit escapes rollback on a non-transactional module, like every other ALTER arm. The hook falls under the module's `ddlTransactionality` declaration. Document; no code change.
- **Isolation, staged rows in the issuer's and another connection's overlay:** both overlays stay usable and unpoisoned, and their rows commit. Verify by test.
- **Isolation, underlying without the hook:** `IsolationModule.alterTags` is undefined. Verify by test (same test file).
- **Store listener seeing the event:** `table_modified` for a table not in the store's catalog is skipped today. No change. Verify by inspection.
- **A returned schema that differs in more than tags:** the engine registers it verbatim, as with every `alterTable` arm. The contract forbids it; the `apply schema` restore check is the backstop on that path. No runtime assertion. Document.
- **A hook that accepts the call and does not apply the edit:** the engine cannot detect it, because the module's result may legitimately differ from the engine's computation. Extend SCH-004 by one sentence: `alterTags` applies or throws, and never silently no-ops.

## Tests

The tag-verb sqllogic coverage already pins the fallback for modules that do not opt in, so add nothing for it.

`packages/quereus/test/vtab/alter-tags-hook.spec.ts`, using a `MemoryTableModule` subclass that defines `alterTags`, records its calls, and returns a schema stamped with a marker tag the engine would not compute:

- Table-driven over the nine statement forms: one call per statement with exact `target` (stored spelling), `mode`, `tags`/`keys` and `ddl`, and `table_info` / `schema()` report the marker from the returned schema rather than an engine-computed set.
- Hook throws a `QuereusError` with a distinctive code: the statement fails with that code, tags are unchanged, and no `table_modified` fires.
- Validation comes first: unknown column, unknown constraint and absent DROP key raise `NOTFOUND` with no hook call; `add tags ()` and `drop tags ()` make no hook call.
- After `analyze`, a tag edit whose hook returns a schema without `statistics` leaves the statistics in the catalog.
- With a schema-event listener attached and no emitter on the module: one `alter`/`column` event for a column target and one `alter`/`table` event for a constraint target, each carrying `ddl`.

`packages/quereus-isolation/test/alter-tags-forwarding.spec.ts`:

- Underlying with the hook: a tag edit with staged rows in an open transaction calls the underlying once, the staged rows stay readable and commit, and a second connection's staged rows are not poisoned. Underlying without the hook: `IsolationModule.alterTags` is undefined.

## TODO

- Add `TagChangeTarget`, `TagChangeInfo` and the `alterTags` hook with TSDoc to `vtab/module.ts`; export the types from `index.ts`
- Add `tagChangeEventShape` to `vtab/alter-event-shape.ts` and export it
- Split the three `SchemaManager` update methods into compute and commit; add `previewTagEdit`; add the `NOTE:` to the programmatic setters' TSDoc
- Add `runTagEdit` to `runtime/emit/alter-table.ts` and route the `setTags` / `dropTags` cases through it; rewrite the comment above `runSetTableTags`
- Correct the comments in `planner/nodes/alter-table-node.ts`, `planner/building/alter-table.ts` and `test/alter-table-schema-events.spec.ts` that say tag arms never reach a module or never announce
- Add the constructor forward to `IsolationModule`; add `alterTags` to the hook list in `packages/quereus-isolation/README.md` § Transparent hook forwarding
- Write the two spec files
- Docs: new `alterTags` section in `docs/module-authoring-schema-changes.md` (contract, `ddl` rule, `tagChangeEventShape`, atomicity, no silent no-op, tag-only return, statistics and generated-graph handling), and mention it in that file's intro; `docs/module-capabilities.md` hook inventory (line 18), a new table row, and the isolation paragraph (line 62); `docs/sql-alter.md` "Catalog-only" bullet (line 206) and the opening sentence of that section (line 199); `docs/usage.md` § What each `ALTER TABLE` arm reports (tag arms silent unless the module implements `alterTags`); `docs/invariants.md` SCH-004 sentence and a `code:` line; `docs/schema-undo-plan.md` restoring `SET TAGS` note
- Run `yarn workspace @quereus/quereus test`, the `@quereus/isolation` tests, the `@quereus/store` tests, `yarn build` and `yarn lint`
