description: Pre-existing soundness gap discovered during review of covering-structure-mv-rowtime-enforcement. A table-level `unique(col)` over a column declared with a non-binary collation (e.g. `col text collate NOCASE`) is enforced with BINARY comparison, not the column's collation — so `'abc'` and `'ABC'` are both accepted under a NOCASE UNIQUE. The auto-built UNIQUE index drops the column's declared collation.
prereq:
files: packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus-store/src/common/store-table.ts, packages/quereus/src/util/comparison.ts, packages/quereus/src/schema/manager.ts
----

## Problem (NOT introduced by the covering-MV ticket — pre-existing)

`MemoryTableManager.ensureUniqueConstraintIndexes` (manager.ts ~176) synthesizes the
auto-index for a table-level UNIQUE constraint as:

```ts
columns: uc.columns.map(colIdx => ({ index: colIdx })),   // <-- no `collation`
```

The index comparator (`MemoryIndex.createSingle/CompositeColumnKeyFunctions`) only applies
a collation when the spec column carries `collation`; with none, it defaults to BINARY.
Contrast `SchemaManager.buildIndexSchema` for an explicit `CREATE [UNIQUE] INDEX`, which
correctly sets `collation: indexedCol.collation || tableColSchema.collation`.

Result: `create table t (id integer primary key, x text collate NOCASE, unique(x))` then
`insert 'abc'` followed by `insert 'ABC'` raises **no conflict** — both rows persist —
even though the column's declared collation is NOCASE. Verified empirically during review.

The store path has the analogous gap: `StoreTable`'s non-PK UNIQUE check
(`findUniqueConflict`) compares with `compareSqlValues(newRow[idx], ...)` (default BINARY)
rather than the column's collation.

## Relationship to covering-MV enforcement

This was found while reviewing `covering-structure-mv-rowtime-enforcement`. That feature's
backing-scan candidate *generator* (`lookupCoveringConflicts`) IS collation-aware, but its
candidate *validator* re-matches with BINARY — which means the covering-MV path nets out to
the same BINARY behavior as the auto-index, so it is **consistent** with (not a regression
over) the index path. Once this gap is fixed, both paths should honor column collation
together (and the covering-MV validator re-match should pass the column collation to
`compareSqlValues` so it stays aligned with the generator).

## Wanted

- Auto-built UNIQUE index columns carry the column's declared collation
  (`{ index, collation: tableSchema.columns[colIdx].collation }`) in
  `ensureUniqueConstraintIndexes` (and the store equivalent).
- Collation-aware comparison in the store UNIQUE check and the covering-MV validator
  re-matches (memory `checkUniqueViaMaterializedView`, store `findUniqueConflictViaCoveringMv`).
- A regression test: `unique` over a `collate NOCASE` column rejects case-only duplicates,
  on memory and store, with and without a row-time covering MV.

## Notes

- Scope is broader than the covering-MV feature; own/scope accordingly.
- `compareSqlValues(a, b, collationName)` already accepts a collation name; `ColumnSchema`
  already carries `collation` (defaults `'BINARY'`).
