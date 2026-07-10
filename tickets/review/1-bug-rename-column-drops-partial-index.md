---
description: Renaming a column used to silently destroy any index whose WHERE clause mentioned that column; now the index survives the rename, and dropping such a column is rejected with a clear message.
prereq:
files:
  - packages/quereus/src/schema/rename-rewriter.ts             # new renameColumnInIndexPredicates
  - packages/quereus/src/vtab/memory/layer/manager.ts          # renameColumn — rewrite + reverse-on-failure
  - packages/quereus/src/vtab/memory/layer/base.ts             # createSecondaryIndexes (swallow removed), rebuildAllSecondaryIndexes (stale-map fix)
  - packages/quereus/src/runtime/emit/alter-table.ts           # runDropColumn pre-check, predicateReferencesColumn, rewriteTableForColumnRename comment
  - packages/quereus/test/partial-index-column-rename.spec.ts  # new regression spec (5 tests)
  - docs/sql.md                                                # RENAME COLUMN / DROP COLUMN semantics
difficulty: medium
---

# Review: `RENAME COLUMN` no longer drops a partial index

## What the bug was

```sql
create table t (id integer primary key, name text, active integer);
create index ix on t (name) where active = 1;
alter table t rename column active to is_active;
```

The memory table's base-layer `secondaryIndexes` map went from `['ix']` to `[]`, while the
catalog still advertised `ix`. Invisible until a plan picked the index by name and got
`Secondary index 'ix' not found`.

Cause: the module's rebuild compiled `ix`'s predicate (`active = 1`) against the *new*
column list, `compilePredicate` threw "unknown column 'active'", and
`BaseLayer.createSecondaryIndexes` caught that, logged, and returned a map missing the index.
The catalog-side predicate rewrite (`propagateColumnRename`) only ran *after* the module call.

## What changed

**A shared predicate rewriter.** `renameColumnInIndexPredicates(indexes, table, oldCol, newCol,
schema, resolve)` in `schema/rename-rewriter.ts` walks `IndexSchema[]` and applies
`renameColumnInCheckExpression` to each `predicate` **in place** (a partial-index predicate
resolves unqualified refs against its own table, exactly like a CHECK). It is idempotent.

**Called inside the module, in the one window that works.**
`MemoryTableManager.renameColumn` calls it after `ensureSchemaChangeSafety()` (which
consolidates transaction layers and rebuilds indexes against the *old* columns — rewriting
before that breaks it) and before `baseLayer.updateSchema(...)` + `handleColumnRename()`
(which rebuild against the *new* columns). The rewrite is in place because the `Expression`
object is shared by reference with the catalog's `TableSchema` and, for a unique partial
index, with the `derivedFromIndex` UNIQUE constraint. So `renameColumn`'s `catch` now also
runs the rewrite in reverse, guarded by a flag so a failure *before* the rewrite un-renames
nothing.

**The swallow is gone.** `BaseLayer.createSecondaryIndexes` no longer catches construction
failures; an index that cannot be built now fails the DDL instead of vanishing. (This also
closes the same hole for an index naming an unregistered collation.) Duplicate-key tolerance
stays in `populateSecondaryIndexes`.

**`DROP COLUMN` of a predicate-referenced column is rejected up front,** in `runDropColumn`
(engine-level, so it covers every module, store included), with
`Cannot drop column 'active' from 't': it is referenced by the WHERE clause of partial index 'ix'`.
Previously it silently lost the index; with the swallow gone it would have surfaced a raw
internal "unknown column" message from deep inside the module. The reference is found by
walking the predicate AST, not by string match.

**Adjacent defect found and fixed.** `BaseLayer.rebuildAllSecondaryIndexes` early-returned
when the schema declared no indexes, *without clearing the map* — so an index dropped by
`DROP COLUMN` (last surviving key column) lingered as an emptied-but-live structure that every
subsequent base write still maintained. Caught by the new "drop a key column" test.

## Use cases to test / validate

The regression spec is `packages/quereus/test/partial-index-column-rename.spec.ts` (5 tests).
It asserts on the memory module's **live** `secondaryIndexes` map, because the existing rename
tests in `test/index-ddl-roundtrip.spec.ts` assert only on reconstructed DDL text and stayed
green with the index gone.

- Partial index survives `RENAME COLUMN`: still in the base map, populated with the right row
  count, predicate rewritten, and `select ... where is_active = 1` returns the right rows both
  before and after further writes.
- **Unique** partial index survives: still rejects a duplicate *inside* its predicate scope
  under the new column name, and still allows the same value *outside* it. This is the check
  that the shared `derivedFromIndex` predicate followed the rewrite.
- `DROP COLUMN` of a predicate-referenced column is rejected, message names both column and
  index, and the index is untouched.
- `DROP COLUMN` of a column used only as an index **key** column still succeeds and removes
  the index cleanly (this is the test that caught the stale-map bug).
- A `RENAME COLUMN` that fails *after* the predicate rewrite rolls the rewrite back: the
  stored predicate AST still names the original column.

Worth trying by hand, beyond the spec:
- The same rename with the predicate written table-qualified (`where t.active = 1`) and
  case-varied (`where ACTIVE = 1`).
- Rename inside an explicit transaction with a prior uncommitted write on the same connection.
- Two partial indexes on the same table, only one naming the renamed column.
- `DROP INDEX ix` then `DROP COLUMN active` — should now succeed.

## Validation run

- `yarn test` from repo root: green. quereus went 6766 → **6771 passing**, 9 pending; every
  other package unchanged.
- `yarn lint` from repo root: clean.
- `yarn workspace @quereus/quereus run build`: clean.

## Known gaps — please poke at these

- **The rollback test uses fault injection.** No engine path can currently fail between the
  predicate rewrite and the rebuild, so the test monkeypatches `BaseLayer.handleColumnRename`
  to reject. That is honest about *what* it covers (the `catch` reverses the rewrite) but it
  reaches past `MemoryTableManager`'s private `baseLayer` to do it. If a reviewer knows a
  naturally reachable failure in that window, the test should use it instead.
- **`yarn test:store` was not run.** The `DROP COLUMN` pre-check is module-agnostic and now
  rejects SQL the store previously accepted. I found no logic test that drops a
  predicate-referenced column, but I did not verify against the LevelDB runner.
- **The store module was investigated, not changed.** It carries the predicate AST forward
  untouched on rename and compiles it lazily at the next write, so it never hits the
  memory module's failure. It does persist its DDL bundle from inside its `alterTable` hook
  while the predicate still names the old column, and depends on the engine's
  `propagateColumnRename` pass firing afterwards to re-persist the corrected bundle. That
  ordering dependency is now stated in a comment at `rewriteTableForColumnRename`. The
  original ticket's "export it for quereus-store (next ticket)" turned out to be unnecessary —
  no follow-up ticket filed. Confirm that reading.
- **`predicateReferencesColumn` is depth-blind.** Fine today: `compilePredicate` rejects
  subqueries and schema-qualified refs in a partial-index predicate. Parked as a `NOTE:` at
  the function.
- Removing the swallow means *any* `MemoryIndex` construction failure now aborts the enclosing
  DDL rather than silently dropping the index. Full suite says nothing relied on that, but it
  is the change with the widest blast radius here.

## Tripwires parked (not tickets)

- `runtime/emit/alter-table.ts`, `rewriteTableForColumnRename` — comment: the store's
  persisted DDL bundle is momentarily stale and is corrected by this pass; if this pass ever
  stops rewriting predicates for hook modules, that staleness becomes permanent.
- `runtime/emit/alter-table.ts`, `predicateReferencesColumn` — `NOTE:` the walk is depth-blind
  and would need a scope stack if partial-index predicates ever admit subqueries.
