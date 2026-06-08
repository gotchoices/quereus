description: Predicate pushdown now traverses AliasNode boundaries (enables view optimization)
files:
  - packages/quereus/src/planner/rules/predicate/rule-predicate-pushdown.ts
  - packages/quereus/test/optimizer/predicate-pushdown.spec.ts
  - packages/quereus/test/logic/08-views.sqllogic
  - docs/optimizer.md
----

## What was built

Added an `AliasNode` case to `tryPushDown()` in `rule-predicate-pushdown.ts`. When a `FilterNode` sits above an `AliasNode` (common after view expansion), the predicate is pushed below the alias boundary, allowing it to continue descending through Project, Sort, etc. and ultimately into the Retrieve pipeline for index exploitation.

The pattern mirrors the existing `SortNode`/`DistinctNode` cases — reconstruct AliasNode with filtered source underneath. Safe because AliasNode only renames `relationName` on attributes; attribute IDs (which predicates reference) are unchanged.

## Review notes

- Code follows existing patterns precisely (3-line body matching Sort/Distinct cases)
- AliasNode safety verified: `buildAttributes()` only changes `relationName`, preserving `id`
- Header comment in rule file updated to list AliasNode as a safe traversal
- `docs/optimizer.md` rule description updated to mention Alias traversal
- No DRY, performance, or maintainability concerns

## Testing

- `predicate-pushdown.spec.ts`: 4 tests passing — includes pushdown through AliasNode and qualified column references
- `08-views.sqllogic`: 1 test passing — includes view filter pushdown correctness and qualified column reference through view alias
- Full suite: 277 passing, 1 pre-existing failure in `08.1-semi-anti-join.sqllogic` (unrelated)
- Build: clean

## Usage

`SELECT * FROM view WHERE id = N` — the predicate pushes through the Alias boundary introduced by view expansion, enabling index seek instead of sequential scan + filter.
