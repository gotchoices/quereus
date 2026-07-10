---
description: Renaming a column silently destroys any partial index whose WHERE clause mentions that column — the index disappears from the table while the catalog still claims it exists.
prereq:
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts        # renameColumn ~1893 — the fix site
  - packages/quereus/src/schema/rename-rewriter.ts           # renameColumnInCheckExpression — put the shared helper here
  - packages/quereus/src/vtab/memory/layer/base.ts           # createSecondaryIndexes ~242 — remove the swallow
  - packages/quereus/src/runtime/emit/alter-table.ts         # runRenameColumn ~248, runDropColumn ~663, rewriteTableForColumnRename ~1649
  - packages/quereus/src/vtab/memory/utils/predicate.ts      # compilePredicate — source of "unknown column"
  - packages/quereus/test/index-ddl-roundtrip.spec.ts        # existing rename tests (DDL text only)
difficulty: medium
---

# `RENAME COLUMN` drops a partial index; rewrite the predicate inside the module

## Reproduced

```sql
create table t (id integer primary key, name text, active integer);
create index ix on t (name) where active = 1;
alter table t rename column active to is_active;
```

Before the `alter`, the memory table's base-layer secondary-index map holds `['ix']`.
After it, `[]`. The catalog still reports `ix` with a correctly rewritten predicate, so
the loss is invisible until a plan picks the index by name and gets
`Secondary index 'ix' not found`.

## Root cause (confirmed, not just suspected)

`MemoryTableManager.renameColumn` swaps in a schema whose columns carry the new name but
whose index `predicate` syntax trees still name the old one, then calls
`BaseLayer.handleColumnRename()` → `rebuildAllSecondaryIndexes()` →
`createSecondaryIndexes()`. Building each `MemoryIndex` compiles the predicate against the
new column list, so `compilePredicate` raises
`Partial-index predicate references unknown column 'active'`. `createSecondaryIndexes`
catches that, logs, and omits the index from the map it returns — and that map replaces
the live one. `propagateColumnRename` fixes the predicate afterwards, but nothing rebuilds.

## Where the rewrite has to happen

**Not before `module.alterTable`.** That was tried and fails: `renameColumn` first calls
`ensureSchemaChangeSafety()`, which consolidates the transaction layer into the base and
*also* rebuilds every secondary index — against the **old** column list. A predicate
rewritten before the module call makes that earlier rebuild throw
`unknown column '<new name>'`. Verified by prototype.

The rewrite must land in the narrow window inside the module, between the moment the
column list changes and the rebuild that follows — i.e. in `MemoryTableManager.renameColumn`,
after `ensureSchemaChangeSafety()` and before `baseLayer.updateSchema(finalNewTableSchema)`.

## Rewrite in place, not on a clone

The predicate `Expression` object is **shared by reference** across three places (verified
by identity check): the catalog `TableSchema`'s `indexes[i].predicate`, the memory
manager's own copy, and — for a unique partial index — the `derivedFromIndex`
`uniqueConstraints[i].predicate` that `appendIndexToTableSchema` synthesizes. The engine's
`rewriteTableForColumnRename` already relies on this sharing (it never touches
`uniqueConstraints[].predicate`). So mutate in place, matching the existing convention;
cloning would silently strand the derived UNIQUE constraint on the old AST.

The consequence is that `renameColumn`'s existing `catch` (which restores
`originalManagerSchema`) must also undo the AST rewrite — re-run it in reverse
(`newName` → `oldName`) — or a failed rename leaves the catalog's predicate naming a
column that no longer exists under that name.

`propagateColumnRename` still runs afterwards and finds the index predicates already
rewritten; its `rewriteTableForColumnRename` returns `changed === false` for them and the
table is not needlessly re-registered. Keep that call — it is the only rewrite for modules
that have no `alterTable` hook at all.

## Removing the swallow changes DROP COLUMN too

Once the ordering is fixed, deleting the `catch` in `BaseLayer.createSecondaryIndexes` is
safe for `RENAME COLUMN` (verified: full `packages/quereus` suite, 6766 passing, with both
changes applied). But it also un-hides a second silent drop:

```sql
alter table t drop column active;   -- ix's predicate still says `active`
```

Today that silently loses `ix`. With the catch gone it fails with the raw internal message
`Partial-index predicate references unknown column 'active'`. Failing is right; that
message is not. `runDropColumn` already rejects dropping a column a generated column
depends on — add the same shape of pre-check for a column named by any partial-index
predicate, so the user sees which index blocks the drop before any module call.
(A column named only by an index's *key columns*, not its predicate, is already handled:
the module narrows the index and drops it if no columns survive.)

## Expected behavior

- After `RENAME COLUMN`, every index the catalog reports still exists as a live structure,
  populated, and usable.
- A rename whose predicate rewrite cannot be applied fails loudly and leaves both the
  table and the predicate ASTs unchanged.
- `DROP COLUMN` of a column referenced by a partial-index predicate is rejected with a
  message naming the column and the index.
- `BaseLayer.createSecondaryIndexes` no longer swallows construction failures. (This also
  closes the hole where a `MemoryIndex` built with a collation the connection has not
  registered would vanish silently — `createMemoryIndex` throws for that since
  `3.3-memory-vtab-collation-resolver`.)

## TODO

- Add a shared helper to `packages/quereus/src/schema/rename-rewriter.ts` — something like
  `renameColumnInIndexPredicates(indexes, tableName, oldCol, newCol, schemaName, resolve)`
  — that walks `IndexSchema[]` and applies `renameColumnInCheckExpression` to each
  `predicate` in place, returning whether anything changed. The renamed table's predicate
  resolves unqualified refs against itself (implicit seed scope), the same as a CHECK
  expression, so `renameColumnInCheckExpression` is the correct entry point, not
  `renameColumnInAst`. Export it for `quereus-store` (next ticket).
- Call it in `MemoryTableManager.renameColumn`, after `ensureSchemaChangeSafety()` and
  before `this.baseLayer.updateSchema(finalNewTableSchema)`. Build the
  `ResolveColumnInSource` callback from `this.db.schemaManager` (mirrors the one
  `propagateColumnRename` builds).
- Reverse the rewrite in that method's `catch` before restoring `originalManagerSchema`,
  guarded by a flag so a failure *before* the rewrite does not un-rename anything.
- Consider whether `rewriteTableForColumnRename` in `runtime/emit/alter-table.ts` should
  keep its index-predicate pass. It is now a no-op for modules with an `alterTable` hook,
  but the schema-only fallback branch (no hook) still depends on it. Leave it; add a
  comment saying why it is idempotent here.
- Remove the `try`/`catch` in `BaseLayer.createSecondaryIndexes` and the doc comment that
  points at this ticket. Keep the duplicate-key tolerance in `populateSecondaryIndexes`.
- Add a pre-check in `runDropColumn` (`runtime/emit/alter-table.ts`) rejecting a drop of a
  column that any `tableSchema.indexes[].predicate` references, with a message naming both
  the column and the index. Model it on the generated-column-dependency check just above.
  Resolve the reference by walking the predicate AST for column refs, not by string match.
- Regression tests — the existing rename tests assert only on reconstructed DDL text, so
  they pass today with the index gone. New tests must assert the *structure*:
  - a partial index survives `RENAME COLUMN` (assert the base layer's `secondaryIndexes`
    map still holds it, and that a query filtered on the renamed column returns the right
    rows);
  - a **unique** partial index survives, and still rejects a duplicate inside its scope
    under the new column name (this exercises the shared `derivedFromIndex` predicate);
  - `DROP COLUMN` of a predicate-referenced column is rejected with the new message;
  - a failed `RENAME COLUMN` leaves the predicate AST naming the original column.
- Run `yarn test` and `yarn lint` from the repo root.
