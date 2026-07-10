---
description: On a persistent store, renaming a column writes the table's saved definition to disk before the partial-index WHERE clause has been updated, so the saved copy still names the old column and is wrong after a reconnect.
prereq: bug-rename-column-drops-partial-index
files:
  - packages/quereus-store/src/common/store-module.ts        # alterTable case 'renameColumn' ~1375; saveTableDDL ~2322; buildCatalogEntry ~2290
  - packages/quereus/src/schema/rename-rewriter.ts           # renameColumnInIndexPredicates — added by the prereq ticket
  - packages/quereus/src/runtime/emit/alter-table.ts         # runRenameColumn — module.alterTable runs before propagateColumnRename
  - packages/quereus-store/test/alter-table-conformance.spec.ts
difficulty: medium
---

# Store persists a stale partial-index predicate on `RENAME COLUMN`

## The hole

`runRenameColumn` calls `module.alterTable` **before** `propagateColumnRename` rewrites
partial-index predicate syntax trees. The memory module notices because it rebuilds its
index structures inside that call (see `bug-rename-column-drops-partial-index`). The store
module has the same ordering problem but a different symptom, because it persists instead
of rebuilding.

`store-module.ts`, `alterTable` case `'renameColumn'`, rewrites the index *column names*
and then calls `saveTableDDL(updatedSchema)`. `saveTableDDL` bundles the table DDL with
its secondary-index DDL (`buildCatalogEntry`), and the index DDL is generated from
`indexSchema.predicate` — which at that moment still names the old column. So the catalog
entry written to the store reads:

```sql
create index ix on t (name) where active = 1;   -- but the column is now `is_active`
```

The in-memory `Expression` object is then mutated in place by `propagateColumnRename`, so
the live session looks correct and nothing on disk is rewritten. The staleness surfaces on
the next process: `rehydrateCatalog` re-parses the entry and rebuilds an index whose
predicate names a column the table does not have.

This has not been reproduced end-to-end yet — the reasoning is from the code path
(`saveTableDDL` at the wrong point in the sequence). **Start by writing the failing test**:
rename a column that a partial index's `WHERE` references, then inspect the persisted DDL
(`loadAllDDL()` — the store tests already use it to assert persisted DDL) and/or reconnect
and query. Confirm the failure before changing anything.

## Expected behavior

- After a `RENAME COLUMN` on a store-backed table, the persisted catalog entry's index DDL
  names the new column in its `WHERE` clause.
- Reconnecting to that store rebuilds the partial index correctly and it still filters and
  (for a unique partial index) still enforces uniqueness within its scope.

## TODO

- Write the failing test first, in `packages/quereus-store/test/` — create a table, a
  partial index (one non-unique, one unique), `alter table … rename column …`, then assert
  the persisted DDL names the new column, and that a fresh connection over the same store
  serves the index. Run with `yarn test:store`.
- In `store-module.ts`'s `'renameColumn'` case, call the shared
  `renameColumnInIndexPredicates` helper (added by the prereq ticket, exported from
  `@quereus/quereus`) on `updatedSchema.indexes` **before** `saveTableDDL(updatedSchema)`.
  The predicate objects are shared by reference with the catalog schema and with any
  `derivedFromIndex` unique constraint, so an in-place rewrite covers all of them and makes
  the later `propagateColumnRename` pass a no-op.
- Mirror the prereq ticket's rollback discipline: if anything after the rewrite throws,
  reverse it, so a failed rename does not leave the in-memory predicate renamed.
- Check the other `alterTable` cases in `store-module.ts` that call `saveTableDDL` for the
  same "persist before the AST is rewritten" shape — `renameTable` is the obvious sibling
  (a partial-index predicate can carry a qualified `t.col` reference, and
  `propagateTableRename` likewise runs after the module call). If it has the bug, fix it
  here; if it does not, say why in the review handoff.
- Run `yarn test` and `yarn test:store`, plus `yarn lint`.
