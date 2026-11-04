description: Changing tags with `alter table … set / add / drop tags` (on the table, a column, or a named constraint) can now reach the table's storage module through a new optional hook, so a module that keeps its own durable table definition can save the edit or refuse it. Modules without the hook behave exactly as before.
architecture: docs/module-authoring-schema-changes.md
files:
  - packages/quereus/src/vtab/module.ts                     # `alterTags` hook; `TagChangeTarget`, `TagEdit`, `TagChangeInfo`
  - packages/quereus/src/vtab/alter-event-shape.ts          # `tagChangeEventShape`
  - packages/quereus/src/index.ts                           # exports
  - packages/quereus/src/schema/manager.ts                  # `resolve{Table,Column,Constraint}TagSwap`, `previewTagEdit`, `tagComputeFor`, NOTEs on the setters
  - packages/quereus/src/runtime/emit/alter-table.ts        # `runTagEdit`, `isEmptyPerKeyTagEdit`, `runCatalogOnlyTagEdit`
  - packages/quereus/src/runtime/emit/ddl-event-scope.ts    # comment
  - packages/quereus/src/planner/nodes/alter-table-node.ts  # comments
  - packages/quereus/src/planner/building/alter-table.ts    # comments
  - packages/quereus-isolation/src/isolation-module.ts      # constructor forward
  - packages/quereus/test/alter-table-schema-events.spec.ts # comments only
  - packages/quereus/test/vtab/alter-tags-hook.spec.ts      # new
  - packages/quereus-isolation/test/alter-tags-forwarding.spec.ts # new
  - docs/module-authoring-schema-changes.md
  - docs/module-capabilities.md
  - docs/module-authoring.md
  - docs/module-events.md
  - docs/schema.md
  - docs/sql-alter.md
  - docs/sql-ddl.md
  - docs/sync-schema.md
  - docs/usage.md
  - docs/invariants.md
  - docs/schema-undo-plan.md
  - packages/quereus-isolation/README.md
----

Filed from the lamina board (lamina slug `bug-engine-side-set-tags-never-reaches-lamina-schema`). The lamina side that consumes this is lamina's `tickets/blocked/wire-engine-tag-verbs-into-lamina-alter-table.md`, which lands after this ships in a published `@quereus/quereus` and `@quereus/isolation` release.

## What was built

`VirtualTableModule.alterTags?(db, schemaName, tableName, change: TagChangeInfo): Promise<TableSchema>`, opted into by presence. `change` carries what the user wrote (`target`, `mode`, then `tags` or `keys`, plus `ddl`), not the resulting set, because a module computes the result against its own stored view.

Statement flow, in `runTagEdit` (`runtime/emit/alter-table.ts`):

- **No hook, or an empty `add tags ()` / `drop tags ()`:** the existing catalog-only dispatch, moved unchanged into `runCatalogOnlyTagEdit`. Silent on the public schema channel, as before.
- **Otherwise:** `SchemaManager.previewTagEdit` runs the setters' own checks against the live table and resolves the target to its stored spelling. Then the hook is awaited, and a throw propagates with the catalog untouched. The answer gets its generated-column graph re-derived and keeps the live `statistics` if it omits them, then is registered. `table_modified` fires, and the statement announces `alter`/`column` for a column target or `alter`/`table` otherwise.

`SchemaManager`'s three `update*Tags` were split into `resolve*TagSwap` (computes, mutates nothing) plus the existing `commitTagUpdate`, mirroring `resolveIndexTagSwap`.

`IsolationModule.alterTags` is assigned in the constructor only when the underlying has it. The forward refreshes the cached underlying instance's schema snapshot and touches no overlay.

Contract details are in `docs/module-authoring-schema-changes.md` § "`alterTags`: metadata-tag edits".

## Accepted limits

- A hook that accepts the call without applying the edit cannot be detected, and a returned schema that differs in more than tags is registered as is. Both are contract statements in the docs (SCH-004 and the `alterTags` section), with no runtime assertion, as planned.
- The programmatic `SchemaManager.set*Tags` / `merge*Tags` / `drop*Tags` stay catalog-only even on an opted-in table. A `NOTE:` at `setTableTags` says they should refuse if a non-test caller ever uses them on such a table.
- `alter index … set tags` is deferred to `feat-index-tag-verbs-reach-the-owning-module` in the backlog.
- `yarn test:store` was not run. The store module does not opt in, so it stays on the catalog path, and `@quereus/store`'s own suite passes.

## Review findings

Reviewed from the `ticket(implement): feat-tag-verbs-reach-the-owning-module` diff before reading the handoff.

**Fixed in this pass (minor)**

- **Stale docs the implementer missed.** Three files still said tag statements never announce, which is now false for an opted-in module: `docs/module-events.md` (auto-path coverage list), `docs/sql-ddl.md` (schema-change event paragraph), and `docs/sync-schema.md` (it said no migration is ever recorded for tag arms, but a hook-path event does map to `alter_column` in `mapSchemaMigrationType` and replays from `ddl`). All three now state the exception. `docs/module-events.md` § "Don't hand-roll the `ALTER TABLE` event shape" also now names `tagChangeEventShape`.
- **Stale comment** in `runtime/emit/ddl-event-scope.ts` listing the tag arms as raising no event; tidied a broken comment line in `vtab/alter-event-shape.ts`.
- **Two contracts left unverified, now tested** in `alter-tags-hook.spec.ts`: `table_modified` on the success path (old object is the live schema, new object is the registered one), and generated-column graph re-derivation (the test module's answer now strips the graph as well as `statistics`). I removed both behaviours from the source temporarily: exactly these two tests failed (19 passing, 2 failing), and the source was restored and compared byte for byte.
- **Test tidying:** removed a redundant second `Database` type import alias from the spec.

**Checked with a throwaway probe spec (deleted, no test kept), no defect found**

- Prepared statement re-run: the hook is called once per run and a second `drop tags (a)` fails `NOTFOUND` against the live table with no second call.
- Prepared statement after drop and re-create on a different module: the plan is invalidated, so the new module's catalog path runs and the old module's hook is not called. This settles the question of `runTagEdit` reading the module from the plan-time schema.
- Module with its own emitter: exactly one event, none after a refusal.
- `apply schema` in `replace` mode: tag drift calls the hook inside the batch. A refused forward step unwinds through a restoring `SET TAGS` that calls the hook, and tags come back. A hook that also refuses the restore gives the documented *undo statement … failed* error with the partial state reported.
- `ddl` replay on a second database: quoted and mixed-case identifiers, keys needing quotes, `''` in strings, negative, boolean, null and large integer values all round-trip. Blob tag values are rejected by the parser, so `tagValueToString`'s lack of a blob form is not reachable.
- Maintained table refused and an unknown reserved key rejected, both before the hook; a valid reserved key on SET and a DROP of a reserved key both reach it.
- Explicit `begin … rollback`: the tag edit stays and the batched event is discarded. This matches every other ALTER arm on a non-transactional module and is covered by the `ddlTransactionality` statement in the docs.

**Checked by reading, no defect found**

- **Other wrappers:** `IsolationModule` is the only module wrapper in the repo. Other `VirtualTableModule` implementers (memory, store, sample plugins) are unaffected by an optional hook.
- **Double emit under isolation:** the isolation wrapper has no emitter, so the engine's gate raises the single auto event, the same as `alterTable`.
- **Sync consumers:** `rekeyOnLocalKeyChange` parses the event's `ddl` with `alterPrimaryKeyColumns` and returns early for anything but an `alterPrimaryKey` action, and `applyLocalTableTransitions` ignores an `alter` without `oldObjectName`, so a tag event cannot re-key or move a table.
- **Materialized views:** `isBodyIrrelevantTableChange` compares fields rather than object identity, so a hook-built schema is treated as a tag change (recompile, not stale).
- **Failure after the hook:** nothing fallible follows it, and `withStatementScopedSchemaEvents` already wraps every arm.
- **Ambiguous constraint name:** the DDL refuses to create that state; the path goes through the shared `resolveNamedConstraintClass`.

**Considered and left alone**

- **`tagComputeFor` restates the setters' one-line computations.** The checks themselves live in the shared `freezeTags` and `mutateTagRecord`, so they cannot drift, and the same one-liners already repeat across the view, materialized-view and index families. Folding only three of six families would be less consistent.
- **The nine `run*Tags` wrappers stay**, as the plan allowed.
- **The `IsolationModule` "no hook" test stays:** a small check, but it pins the branch that keeps store and memory underlyings on the catalog path.
- **Type safety, resource cleanup, performance:** no `any`, no new resources held, and the preview's discarded swap is a small allocation on a statement that is not a hot path.

**Tripwires and tickets**

- No new tickets and no new `NOTE:` tripwires. The implementer's `NOTE:` on `setTableTags` covers the programmatic setters. The site-claim check found `feat-index-tag-verbs-reach-the-owning-module` already in the backlog for the deferred index path.
- **File size, already over any comfortable length before this ticket:** `wc -l` gives `runtime/emit/alter-table.ts` 2860 lines, `schema/manager.ts` 3755 lines and `isolation-module.ts` 2114 lines. By `git show --numstat`, this ticket's implement commit added a net 64 lines to the first and 71 to the second, so no split was warranted here.
- `docs/usage.md` is 154 words from the 12000-word cap, per `yarn docs:check`, which passes. Its next addition may need a split.

**Validation on the final code**

`yarn workspace @quereus/quereus test` 11038 passing, 26 pending. `@quereus/isolation` 451 passing, typecheck exit 0. `@quereus/store` 1986 passing. `yarn workspace @quereus/quereus lint` exit 0. `yarn build` and `yarn docs:check` clean.
