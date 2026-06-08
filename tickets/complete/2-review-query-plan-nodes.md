description: Review of query plan nodes (reference, table-access, filter, project, alias, sort, limit-offset, distinct, single-row, values, retrieve)
files:
  packages/quereus/src/planner/nodes/reference.ts
  packages/quereus/src/planner/nodes/table-access-nodes.ts
  packages/quereus/src/planner/nodes/filter.ts
  packages/quereus/src/planner/nodes/project-node.ts
  packages/quereus/src/planner/nodes/alias-node.ts
  packages/quereus/src/planner/nodes/sort.ts
  packages/quereus/src/planner/nodes/limit-offset.ts
  packages/quereus/src/planner/nodes/distinct-node.ts
  packages/quereus/src/planner/nodes/single-row.ts
  packages/quereus/src/planner/nodes/values-node.ts
  packages/quereus/src/planner/nodes/retrieve-node.ts
----
## Findings

### smell: FunctionReferenceNode shares nodeType with TableFunctionReferenceNode
file: packages/quereus/src/planner/nodes/reference.ts:296
Both classes use `PlanNodeType.TableFunctionReference`. Code dispatching on `nodeType` cannot distinguish them. Neither reaches the emitter currently, but this is fragile.
Ticket: tickets/fix/function-reference-node-shared-nodetype.md

### smell: SortCapable interface loses nulls ordering
file: packages/quereus/src/planner/nodes/sort.ts:147
`withSortKeys()` discards `nulls` ordering because the `SortCapable` interface doesn't include it. Optimizer rules that rewrite sort keys will silently lose NULLS FIRST/LAST semantics.
Ticket: tickets/plan/sort-capable-nulls-ordering.md

### note: table-access-nodes.ts uses `throw new Error` instead of `quereusError`
file: packages/quereus/src/planner/nodes/table-access-nodes.ts:61
All `withChildren` methods in table-access nodes use `throw new Error(...)` while other node files use `quereusError(msg, StatusCode.INTERNAL)`. Inconsistent but functionally equivalent since these are internal invariant violations.

### note: IndexSeekNode and ValuesNode use fragile ScalarPlanNode type guard
file: packages/quereus/src/planner/nodes/table-access-nodes.ts:335
file: packages/quereus/src/planner/nodes/values-node.ts:111
Both use `'expression' in child` to check for ScalarPlanNode. Any object with an `expression` property would pass. Works because only plan nodes are passed, but `isScalarNode()` would be more robust.

### note: AliasNode.buildType drops `generated` column property
file: packages/quereus/src/planner/nodes/alias-node.ts:40
When rebuilding the type, columns are reconstructed from attributes as `{ name, type }`, losing the `generated` flag from the source type's columns. This could matter if downstream code checks `generated` through an alias.

### note: ValuesNode type inference uses only first row
file: packages/quereus/src/planner/nodes/values-node.ts:54
Column types are inferred from the first row only. If subsequent rows have wider types, this won't be reflected. Likely handled at the planner level during building, not a node-level concern.

### note: RetrieveNode missing estimatedRows and computePhysical
file: packages/quereus/src/planner/nodes/retrieve-node.ts
RetrieveNode doesn't define `estimatedRows` or `computePhysical`. Acceptable since the emitter throws — it must be rewritten by the optimizer before emission.

## Trivial Fixes Applied
- reference.ts:90-103 — Fixed mixed indentation (2-space → tabs) on ColumnBindingProvider methods
- filter.ts:140-143 — Fixed mixed indentation (2-space → tabs) on PredicateSourceCapable methods
- alias-node.ts:13 — Added missing `override` keyword on `nodeType`
- project-node.ts:143 — Removed redundant `as ColumnReferenceNode` cast (after `instanceof` check)

## No Issues Found
- table-access-nodes.ts (SeqScanNode, IndexScanNode, EmptyResultNode, IndexSeekNode) — structurally clean, correct child management and physical property computation
- filter.ts — clean; predicate handling, cost model, and physical property derivation are correct
- project-node.ts — well-implemented; attribute ID preservation through withChildren is correct and critical
- limit-offset.ts — clean; runtime emitter properly handles negative/invalid values
- distinct-node.ts — clean; BTree-based dedup with collation support in emitter is solid
- single-row.ts — clean singleton pattern with appropriate ConstantNode implementation
- retrieve-node.ts — clean boundary node; correctly delegates to source pipeline
