description: Refactored 6 DDL nodes to extend VoidNode class instead of PlanNode + VoidNode interface
files:
  packages/quereus/src/planner/nodes/plan-node.ts
  packages/quereus/src/planner/nodes/create-assertion-node.ts
  packages/quereus/src/planner/nodes/drop-assertion-node.ts
  packages/quereus/src/planner/nodes/add-constraint-node.ts
  packages/quereus/src/planner/nodes/alter-table-node.ts
  packages/quereus/src/planner/nodes/declarative-schema.ts
----
## Summary

Changed 6 DDL/schema nodes from `extends PlanNode implements VoidNode` to `extends VoidNode`, eliminating ~95 lines of duplicated boilerplate (`getType()`, `getChildren()`, `withChildren()`) now inherited from the `VoidNode` abstract class (plan-node.ts:233-253).

Nodes updated: CreateAssertionNode, DropAssertionNode, AddConstraintNode, AlterTableNode, DeclareSchemaNode, ApplySchemaNode.

AddConstraintNode and AlterTableNode retain their `getRelations()` overrides (returning table references for optimizer/analysis passes).

## Testing

- Build passes
- All 1013 quereus tests pass, no new lint errors
- Coverage: 95-assertions.sqllogic, 40-constraints.sqllogic, 41-alter-table.sqllogic, 50-declarative-schema.sqllogic, emit-create-assertion.spec.ts, vtab-events.spec.ts, quereus-store alter-table.spec.ts, schema-differ.spec.ts
