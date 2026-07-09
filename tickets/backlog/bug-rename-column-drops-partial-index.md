----
description: Renaming a column silently destroys any partial index whose WHERE clause mentions that column — the index vanishes from the table's storage while the catalog still claims it exists.
prereq:
files:
  - packages/quereus/src/runtime/emit/alter-table.ts        # runRenameColumn — calls module.alterTable BEFORE propagateColumnRename
  - packages/quereus/src/vtab/memory/layer/manager.ts        # renameColumn ~1893 — rewrites index column names, not index predicates
  - packages/quereus/src/vtab/memory/layer/base.ts           # createSecondaryIndexes — the catch that turns the failure silent
  - packages/quereus/src/vtab/memory/utils/predicate.ts      # compilePredicate — raises "unknown column"
  - packages/quereus/test/index-ddl-roundtrip.spec.ts        # RENAME COLUMN predicate-rewrite tests (assert DDL text only)
difficulty: medium
----

# `RENAME COLUMN` silently drops a partial index that references the renamed column

## What happens

```sql
create table t (id integer primary key, name text, active integer);
create index ix on t (name) where active = 1;
alter table t rename column active to is_active;
```

After the rename the catalog still reports the index, with a correctly rewritten
predicate (`... WHERE is_active = 1` — `test/index-ddl-roundtrip.spec.ts` pins that).
But the memory table's actual index structure is **gone**. Verified directly: the base
layer's secondary-index map holds `['ix']` before the statement and `[]` after.

Queries keep returning correct rows, because the planner falls back to a full scan when
it cannot find the structure — so the loss is invisible until either performance matters
or some path does pick the index by name, at which point it raises
`Secondary index 'ix' not found`.

## Why

Three things line up:

1. `runRenameColumn` (`runtime/emit/alter-table.ts`) calls the virtual-table module's
   `alterTable` **first**, and only afterwards calls `propagateColumnRename`, which is
   what rewrites partial-index predicate syntax trees to use the new column name.
2. The memory module's `renameColumn` rewrites the *column names* recorded on each index
   but leaves each index's `predicate` syntax tree alone. It then rebuilds every secondary
   index against the new column list — while the predicate still says `active`.
3. That rebuild calls `compilePredicate`, which raises
   `Partial-index predicate references unknown column 'active'`. `BaseLayer.createSecondaryIndexes`
   catches the error, logs it, and continues — so the index is simply absent from the map
   it returns, and that map replaces the live one.

Nothing rebuilds the index once `propagateColumnRename` fixes the predicate.

## Expected behavior

- After `RENAME COLUMN`, every index the catalog reports still exists as a live structure
  in the table, populated, and usable by the planner.
- A rename whose predicate rewrite genuinely cannot be applied fails the statement loudly
  and leaves the table unchanged — it never leaves a catalog entry with no structure
  behind it.
- Index construction failure during a rebuild should not be swallowed. Today
  `BaseLayer.createSecondaryIndexes` catches every error from constructing a `MemoryIndex`
  and drops the index. Removing that catch is the right end state, but it cannot be done
  until the rename ordering is fixed — it currently makes the statement above throw.
  (The same swallow would silently hide a `MemoryIndex` built with a collation the
  connection has not registered, which since `3.3-memory-vtab-collation-resolver` throws
  rather than falling back to byte order.)

## Notes for whoever picks this up

- The likely shape is to rewrite the predicate syntax tree inside the module's
  `renameColumn` (alongside the index column-name rewrite it already does), or to run the
  predicate propagation before `module.alterTable` rather than after. The second ordering
  affects every module, not only memory.
- Persistent storage modules (`quereus-store`) route the same statement through the same
  `runRenameColumn`; check whether they have the same hole before assuming this is
  memory-only.
- The existing rename tests assert only on the reconstructed DDL text. A regression test
  must assert the index structure still exists and still serves a query.
