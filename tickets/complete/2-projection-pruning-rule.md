description: Projection pruning optimizer rule — eliminates unused columns from inner ProjectNode in Project-on-Project patterns
files:
  - packages/quereus/src/planner/rules/retrieve/rule-projection-pruning.ts
  - packages/quereus/src/planner/optimizer.ts (rule registration at priority 19)
  - packages/quereus/test/optimizer/projection-pruning.spec.ts
  - packages/quereus/test/logic/08-views.sqllogic
  - docs/optimizer.md (rule catalog entry added)
----

## What was built

A structural rewrite rule (`ruleProjectionPruning`) that detects Project-on-Project patterns (common after view expansion) and prunes unused inner projections. Registered in the Structural pass at priority 19.

### Algorithm

When an outer `ProjectNode`'s source is another `ProjectNode`:
1. Collect attribute IDs referenced by outer project's scalar expressions (walking `ColumnReferenceNode` leaves).
2. Filter inner project's projections to only those whose output attributes are in the referenced set.
3. Rebuild both nodes preserving attribute IDs.

Skips when all inner projections are referenced or pruning would yield zero projections.

## Testing

- 5 unit tests in `projection-pruning.spec.ts` (prune subset, correctness with filter, preserve all, join with partial view, count(*))
- 2 SQL logic tests in `08-views.sqllogic` (subset select, filter + partial projection)
- Build passes, lint clean on new file, 267 tests pass (1 pre-existing failure in `08.1-semi-anti-join.sqllogic` — unrelated)

## Review notes

- Code is clean, focused, follows established rule patterns (same shape as `ruleDistinctElimination`)
- Attribute ID preservation is correct — uses `predefinedAttributes` path in `ProjectNode` constructor
- Priority ordering (19) is appropriate: after distinct-elimination (18), before predicate-pushdown (20)
- Minor: rule lives in `rules/retrieve/` which is slightly misaligned with its function (operates on ProjectNode, not RetrieveNode), but not worth moving given the small category
- Docs updated: added entry to optimizer.md rule catalog under **Retrieve** section
