description: Changing tags with `alter table … set / add / drop tags` (on the table, a column, or a named constraint) can now reach the table's storage module through a new optional hook, so a module that keeps its own durable table definition can save the edit or refuse it. Modules without the hook behave exactly as before.
architecture: docs/module-authoring-schema-changes.md
files:
  - packages/quereus/src/vtab/module.ts                     # `alterTags` hook; `TagChangeTarget`, `TagEdit`, `TagChangeInfo`
  - packages/quereus/src/vtab/alter-event-shape.ts          # `tagChangeEventShape`
  - packages/quereus/src/index.ts                           # exports
  - packages/quereus/src/schema/manager.ts                  # `resolve{Table,Column,Constraint}TagSwap`, `previewTagEdit`, `tagComputeFor`, NOTEs on the setters
  - packages/quereus/src/runtime/emit/alter-table.ts        # `runTagEdit`, `isEmptyPerKeyTagEdit`, `runCatalogOnlyTagEdit`
  - packages/quereus/src/planner/nodes/alter-table-node.ts  # comments
  - packages/quereus/src/planner/building/alter-table.ts    # comments
  - packages/quereus-isolation/src/isolation-module.ts      # constructor forward
  - packages/quereus/test/alter-table-schema-events.spec.ts # comments only
  - packages/quereus/test/vtab/alter-tags-hook.spec.ts      # new
  - packages/quereus-isolation/test/alter-tags-forwarding.spec.ts # new
  - docs/module-authoring-schema-changes.md
  - docs/module-capabilities.md
  - docs/module-authoring.md
  - docs/schema.md
  - docs/sql-alter.md
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

`SchemaManager`'s three `update*Tags` were split into `resolve*TagSwap` (computes, mutates nothing) plus the existing `commitTagUpdate`, mirroring `resolveIndexTagSwap`. `previewTagEdit` drives the same compute steps, so its checks cannot drift from the setters.

`IsolationModule.alterTags` is assigned in the constructor only when the underlying has it. The forward refreshes the cached underlying instance's schema snapshot and touches no overlay.

## Differences from the plan

- Added a named `TagEdit` type (also exported), shared by `TagChangeInfo` and `previewTagEdit`, instead of writing the union out twice.
- Updated `docs/schema.md` and `docs/module-authoring.md` too. They were not on the ticket's list, but they described tag edits as always catalog-only or listed the hook surface.
- The `NOTE:` about bypassing `alterTags` is written out on `setTableTags`. The other eight setters carry a one-line pointer to it.

## Tests

`packages/quereus/test/vtab/alter-tags-hook.spec.ts` (19 cases, using a `MemoryTableModule` subclass whose answer carries a marker tag the engine would not compute):

- Nine statement forms, table-driven: one call per statement with exact `target` (stored spelling), `mode`, `tags` / `keys` and `ddl`, and the introspection functions report the marker. Includes `add tags (k = null)` as a stored value and a case-sensitive tag key.
- A refusal: the statement fails with the module's code and message, the catalog object is the same one as before, and no change notification fires.
- Validation first: unknown column, unknown constraint, absent DROP key and a partly absent DROP list raise `NOTFOUND` with no call.
- `add tags ()` and `drop tags ()` make no call, but an unknown target still raises `NOTFOUND`.
- `set tags ()` does call the hook.
- After `analyze`, a return without `statistics` leaves the statistics in the catalog.
- With a listener and no module emitter: one `alter`/`column` event for a column target and one `alter`/`table` event for a constraint target, each carrying `ddl`.

`packages/quereus-isolation/test/alter-tags-forwarding.spec.ts` (2 cases):

- Underlying with the hook: one forwarded call, both connections read their own staged rows, and both commit.
- Underlying without the hook: `IsolationModule.alterTags` is undefined.

I checked that the hook spec detects breakage by temporarily removing the statistics carry (1 failure), passing the statement's spelling instead of the stored one (6 failures), and skipping DROP validation in the preview (2 failures). All were restored, and the source matched its backup byte for byte.

## Validation run

On the final code: `yarn workspace @quereus/quereus test` 11036 passing, 26 pending; `@quereus/isolation` 451 passing and its typecheck clean; `@quereus/store` 1986 passing. `yarn build`, `yarn lint` and `yarn docs:check` are clean.

`yarn test:store` was not run. The store module does not opt in, so it stays on the catalog path.

## Known gaps

These were checked by reading the code, not by a test, so they are good places to push on:

- **`table_modified` on the success path** is not asserted (only its absence on a refusal is). Removing that call would fail no new test, and cached plans would then go stale after a hook edit.
- **Generated-column graph re-derivation** in `runTagEdit` is not asserted.
- **A module with its own emitter that also implements the hook:** nothing in the repo does this, so `tagChangeEventShape` runs only through the engine's auto-event path, and the "exactly one event" property relies on the existing gate in `emitAutoSchemaEventIfNeeded`.
- **`apply schema` through the hook** (differ tag drift in `replace` mode, and a restoring `SET TAGS` during an unwind) is documented but not exercised.
- **Ambiguous constraint name** is not tested, because the DDL refuses to create that state. It goes through the shared `resolveNamedConstraintClass`.
- **Prepared statement re-run, maintained-table refusal, and reserved-key refusal before the hook** were verified by inspection, as the plan specified.

## Accepted limits

- A hook that accepts the call without applying the edit cannot be detected, and a returned schema that differs in more than tags is registered as is. Both are contract statements in the docs (SCH-004 and the `alterTags` section), with no runtime assertion, as planned.
- The programmatic `SchemaManager.set*Tags` / `merge*Tags` / `drop*Tags` stay catalog-only even on an opted-in table. A `NOTE:` at `setTableTags` says they should refuse if a non-test caller ever uses them on such a table.
- `alter index … set tags` is deferred to `feat-index-tag-verbs-reach-the-owning-module` in the backlog.

`docs/usage.md` grew and is 154 words from the 12000-word cap. `yarn docs:check` passes, but its next addition may need a split.
