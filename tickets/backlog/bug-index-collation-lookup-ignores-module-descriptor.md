---
description: When a virtual-table module tells the planner which index it chose and which collation that index's key columns use, the planner's collation safety check ignores that information and assumes a plain byte-order index, so a case-sensitive comparison can be answered by a case-insensitive index with no re-check and return rows that should not match.
files:
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts   # indexColumnCollationLookup — resolves a non-primary index's member collation ONLY through tableSchema.indexes, never through accessPlan.indexDescriptor; classifyCollationCover consumes its answer
  - packages/quereus/src/vtab/best-access-plan.ts                           # IndexDescriptor.keyColumns[].collation — the module-supplied collation the lookup should read; BestAccessPlanResult.indexDescriptor
  - packages/quereus/docs/module-authoring.md                               # "Naming the chosen index" — says what the descriptor is for; should state that the cover analysis reads its collations
repro: verified
severity: wrong-result
likelihood: unusual
tradeoffs: Only a module that describes a collation-folded index to the planner AND leaves the planner to decide the collation cover is exposed; the in-memory and store modules register their indexes on the table schema, where the lookup already finds them, so a maintainer may rank this below engine-internal defects — but the wrong answer is silent and the fix is a two-line fallback in one lookup.
---

# The access-path collation cover ignores a module-described index's collations

Filed from the lamina board (`feat-collated-pk-ordered-read-path`); lamina is the module that hit it.

## What happens

`rule-select-access-path.ts`'s index-aware arm (`selectPhysicalNodeFromPlan`) runs `classifyCollationCover` over the module's `seekColumnIndexes`, comparing each equality's effective collation (`effectivePredicateCollation`) with the index's collation for that column. The index side comes from `indexColumnCollationLookup(tableSchema, accessPlan)`, which resolves a non-primary index **only** through `tableSchema.indexes.find(i => i.name === accessPlan.indexName)` and returns `BINARY` when nothing matches.

A module whose indexes are not registered on the table schema — lamina advertises a fresh synthetic alias per plan (`_compound_<name>_<seq>`), and describes the index through `BestAccessPlanResult.indexDescriptor`, whose `keyColumns[].collation` carries the folded collation per the `IndexDescriptor` contract — never matches, so every one of its indexes is classified as `BINARY`-keyed. A predicate compared under `BINARY` over a `NOCASE`-keyed index is then `MATCH` (exact), the equality is consumed, no residual is attached, and the module's folded seek returns the case-insensitive superset.

Measured against lamina (quereus 4.20.2), `create table t (g integer, k text collate nocase, primary key (g, k))` with one row `(1, 'alice')`:

```
select k from t where g = 1 and k = 'ALICE' collate binary
→ [["alice"]]        -- expected []
plan: IndexSeek USING _compound__pk_t_2 (both keys consumed, no Filter)
```

The same predicate under the declared `NOCASE` (`k = 'ALICE'`) is classified `MISMATCH_UNSAFE` (`NOCASE` predicate vs the assumed `BINARY` index) and declined to a SeqScan + residual — correct, but it also means a module-described collation-folded index can never be seeked under its own collation.

## Expected

`indexColumnCollationLookup` falls back to `accessPlan.indexDescriptor?.keyColumns.find(c => c.columnIndex === colIdx)?.collation` when the index is not on `tableSchema.indexes` (the descriptor is already validated against `indexName` by `validateIndexDescriptor`, so the two cannot name different indexes). With that, the example above classifies `COARSER_SAFE` (BINARY predicate over a NOCASE index) — seek plus the equality residual — and `k = 'ALICE'` classifies `MATCH` and seeks.

Lamina's side now declines to consume an equality on any collation-folded compound member (`makeCompoundPlan`, `packages/lamina-quereus/src/planner.ts`, with a `NOTE:` naming this ticket as the revisit condition), so the wrong answer is closed there regardless; this fix is what lets such a module seek again.
