description: The planner's two collation safety checks now find the module's chosen index the same way the rest of the planner does (module descriptor, then primary key, then a case-insensitive schema match), and an index they cannot find is treated conservatively, so a filtered `order by` keeps its sort and a binary filter over a case-insensitive index keeps its re-check.
architecture: docs/optimizer-retrieve.md#access-path-selection
files: packages/quereus/src/planner/rules/access/rule-select-access-path.ts (`resolveIndexKeyCollations`, `indexColumnCollationLookup`, `orderingClaimSurvivesCollation`, `classifyConstraintCover`, `classifyCollationCover`), packages/quereus/test/vtab/access-path.spec.ts, packages/quereus/test/vtab/test-aliased-index-module.ts, packages/quereus/test/index-ddl-roundtrip.spec.ts, docs/module-authoring.md ("Naming the chosen index"), docs/optimizer-retrieve.md (the `orderingClaimSurvivesCollation` bullet)
----
## What changed

Both collation checks in `rule-select-access-path.ts` used their own exact-name `tableSchema.indexes.find(i => i.name === indexName)` and fell back in opposite directions on a miss: the ordering guard trusted the module's claim (Sort dropped), the seek arms assumed BINARY (a BINARY equality over a NOCASE index lost its re-check). Both now go through one helper:

- `resolveIndexKeyCollations(tableSchema, accessPlan, indexName)` → `Map<columnIndex, normalizedCollation> | undefined`. It resolves via `resolveIndexDescriptor`. A module-supplied descriptor's `keyColumns[].collation` is authoritative (absent ⇒ BINARY). The engine's own primary-key descriptor (role `primary`, not the module's descriptor) reads each column's declared collation instead of `primaryKeyDefinition[].collation`, because the store's `reconcilePkCollations` re-collates the column and leaves the definition stale (confirmed by reading the code: it returns `{ ...schema, columns, columnIndexMap }`). This keeps primary-key behaviour identical to before.
- `indexColumnCollationLookup(tableSchema, accessPlan)` (seek arms, `accessPlan.indexName`) returns `colIdx => string | undefined`: undefined for an unresolvable index or a column the index does not hold.
- `orderingClaimSurvivesCollation` resolves `orderingIndexName ?? indexName`. With a resolved index it skips constraints on columns outside the index (as before). With an unresolvable index it classifies every bearing constraint against an unknown collation; the old `return true` is gone.
- `classifyConstraintCover(predColl, indexColl: string | undefined, …)`: unknown index collation → `COARSER_SAFE` for a BINARY equality, `MISMATCH_UNSAFE` for everything else (non-BINARY equality, any range). `rule-key-set-seek` still passes a string (it declines unresolved descriptors itself) and shares the rule.

## Behaviour changes a reviewer should weigh

- **Aliased modules without a descriptor** (already warned by `buildIndexAccessPath`): a BINARY equality seek now gets a re-check `FILTER` above it (was a bare seek); a NOCASE equality or **any range seek, even BINARY**, is now declined to a sequential scan plus residual (was a seek). This is the rule the ticket specified; it costs performance for modules that alias without a descriptor.
- **A plan that claims ordering but names no index at all** now goes through the unknown-collation rule in the guard instead of `return true`, so it keeps its Sort when a collated equality or any handled range bears on the claim. No in-tree test depended on the old behaviour.
- **Duplicate index name** (`index-ddl-roundtrip.spec.ts`, "an index whose name a UNIQUE constraint on the same table holds imports…"): that test pinned "the predicate over the shadowed index stops filtering" (2 rows). Now `foo` resolves to the constraint's index on `a`, the seek column `b` is not one of its key columns, so the predicate is re-checked above the seek and the query returns the correct single row. I updated the assertion to `[{ id: 2 }]` and the comment says the re-check only rescues an over-fetching seek. The other pinned damage (two entries, not in `index_info`, `DROP INDEX` refuses) is unchanged. Reviewer: confirm that rewriting a "known damage" pin is acceptable here rather than a regression.

## Tests added (all in `test/vtab/access-path.spec.ts`; all four failed at HEAD before the fix)

- "a module that names the chosen index in another letter case › keeps the sort the index cannot replace under a nocase equality over a binary index": arm A end-to-end. A `MemoryTableModule` subclass upper-cases secondary index names (`idx_bc` → `IDX_BC`); `where b = 'x' collate nocase order by c` over `idx_bc(b, c)` returns 2, 5, 1, 4 (HEAD returned 1, 2, 4, 5) and the plan has one `SortNode`. The 300 filler rows from the ticket were not needed to reproduce.
- "… › re-checks a binary equality over a nocase index": arm B, case-insensitive route. `where b = 'x'` over `idx_bc(b collate nocase, c)` plans `FILTER` directly above `INDEXSEEK`.
- "a module that aliases the primary-key index name › with an indexDescriptor, seeks under the collation the descriptor states": arm B, descriptor route (lamina's shape). BINARY column, descriptor states NOCASE (new `descriptorCollation` field on `TestAliasedIndexModule`): BINARY equality → seek + filter; NOCASE equality → plain seek.
- "… › without an indexDescriptor, re-checks a binary equality and declines a collated one": pins the unknown-collation rule in `classifyConstraintCover`.

A shared `accessLeafOf` helper now also feeds the existing `accessPathOf`. No new logic test: `05.1.1-secondary-index-range-scan.sqllogic` already covers the memory-table shape with exact names.

## Validation

`yarn test` (all workspaces) and `yarn lint` from the repo root both pass. `yarn test:store` was not run.

## Known gaps / observations

- Not covered by a test: the guard's unresolved-index arm for a **range** constraint (the guard keeps the Sort) and the "column not in the resolved index" arm of the seek lookup, apart from the duplicate-name round-trip test that now exercises it by accident.
- Filed `backlog/bug-store-primary-key-definition-keeps-pre-rewrite-collation` (repro: static): the store's stale `primaryKeyDefinition[].collation` reaches `primaryKeyDescriptor` (isolation overlay window filter) and the DML data-change event comparators. This change avoids it in the planner by reading the column; those two consumers still read the stale value.
- The memory runtime looks indexes up by exact name, so the upper-casing test module can only run plans that decline its seek; arm B is asserted at plan level only. Lamina measured the wrong rows end-to-end on its own side (see the original ticket).
