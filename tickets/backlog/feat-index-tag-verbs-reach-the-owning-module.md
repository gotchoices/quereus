description: Changing tags with `alter index … set / add / drop tags` only edits the engine's in-memory catalog, so a storage module that keeps its own durable copy of its indexes' tags loses the change on reopen and cannot refuse it. Extend the new module hook for table, column and constraint tag edits to cover indexes too.
prereq: feat-tag-verbs-reach-the-owning-module
architecture: docs/module-authoring-schema-changes.md
files:
  - packages/quereus/src/runtime/emit/set-object-tags.ts  # index arm of emitSetObjectTags; its NOTE about the strict-policy check
  - packages/quereus/src/schema/manager.ts                # updateIndexTags / resolveIndexTagSwap
  - packages/quereus/src/vtab/module.ts                   # TagChangeTarget gains an index arm
  - packages/quereus-isolation/src/isolation-module.ts
  - docs/module-authoring-schema-changes.md
  - docs/sql-alter.md
tradeoffs: Lamina is the only known consumer and it can live without index tags for now, while this path has more special cases than the table verbs (a separate emitter, resolving the owner from an index name, and a store-only fallback), so a maintainer might wait for a concrete need.
----

Split out of `feat-tag-verbs-reach-the-owning-module`, which covers table, column and named-constraint tags and leaves this path catalog-only. Lamina persists index tags and would use this.

## Expected behavior

When the module that owns the index's table implements `alterTags`, `alter index … set / add / drop tags` calls it with an `index` target, under the same contract as the other targets: awaited, a throw fails the statement and leaves the catalog unchanged, engine validation runs first, the returned schema is registered, and `table_modified` fires afterwards. A module without the hook keeps today's catalog-only path.

## What differs from the table verbs

- The statement runs through `runtime/emit/set-object-tags.ts`, which has no `ddl_transaction_policy = 'strict'` check because it dispatches to no module today. Its `NOTE:` says to add the check once a module persists tags, so the hook path needs it. Whether the catalog-only path should also be checked is part of this ticket.
- The owning table has to be resolved from the index name before the module is known.
- A store-mode exposed implicit index has no `IndexSchema`, so its tags are stored on the originating UNIQUE constraint's `exposedIndexTags` (see `resolveIndexTagSwap`). The contract must say what a module sees for such an index.
- The node carries no canonical statement text today, so `ddl` needs rendering at plan-build as `AlterTableNode.sql` does.
