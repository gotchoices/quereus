description: IS NULL / IS NOT NULL index-level optimization — EmptyResult for impossible predicates
prereq: vtab-extended-constraint-pushdown (complete)
files:
  - packages/quereus/src/planner/analysis/constraint-extractor.ts
  - packages/quereus/src/vtab/memory/module.ts
  - packages/quereus/src/planner/nodes/plan-node-type.ts
  - packages/quereus/src/planner/nodes/table-access-nodes.ts
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts
  - packages/quereus/src/runtime/emit/empty-result.ts
  - packages/quereus/src/runtime/register.ts
  - packages/quereus/test/optimizer/extended-constraint-pushdown.spec.ts
----

## What was built

IS NULL and IS NOT NULL predicates are now extracted as `PredicateConstraint` entries and optimized at the access-planning level:

1. **IS NULL on NOT NULL column** → `EmptyResultNode` physical plan node (zero cost, zero rows, no table access)
2. **IS NOT NULL on NOT NULL column** → marked as handled (tautology eliminated, no residual filter)
3. **IS NULL / IS NOT NULL on nullable columns** → extracted as constraints but left unhandled (residual filter)

### Key components

- **`extractNullConstraint()`** in constraint-extractor.ts: Extracts `IS NULL` / `IS NOT NULL` from `UnaryOpNode` as `PredicateConstraint` with op `'IS NULL'` or `'IS NOT NULL'`.
- **`EmptyResultNode`** in table-access-nodes.ts: Physical plan node extending `TableAccessNode`, returns 0 estimated rows, empty unique keys.
- **`emitEmptyResult()`** in empty-result.ts: Emitter producing a zero-row `AsyncIterable<Row>`.
- **MemoryTableModule.findBestAccessPlan()**: Pre-pass detects IS NULL on NOT NULL → returns `rows: 0` with all filters handled. Post-pass marks IS NOT NULL on NOT NULL as handled.
- **`selectPhysicalNode()`**: Detects `rows === 0` with all filters handled → produces `EmptyResultNode`.

## Testing

26 tests in `extended-constraint-pushdown.spec.ts` pass, covering:
- IS NULL on NOT NULL columns returns empty (correctness)
- IS NOT NULL on NOT NULL columns returns all rows (correctness)
- IS NULL / IS NOT NULL on nullable columns (correctness)
- IS NULL combined with AND short-circuits to EmptyResult (plan-level)
- Plan-level verification that EmptyResult node appears for impossible predicates
- Plan-level verification that EmptyResult does NOT appear for nullable columns or IS NOT NULL

Full suite: all tests passing, build clean.

## Docs updated

- `docs/memory-table.md`: Documents IS NULL optimization behavior
- `docs/optimizer.md`: Lists `EmptyResultNode` in physical access nodes; mentions IS NULL/IS NOT NULL in constraint extraction
- `docs/plugins.md`: `ConstraintOp` type updated to include `IN` and `NOT IN`
