description: Review of DDL and DML plan nodes
files:
  packages/quereus/src/planner/nodes/insert-node.ts
  packages/quereus/src/planner/nodes/update-node.ts
  packages/quereus/src/planner/nodes/delete-node.ts
  packages/quereus/src/planner/nodes/dml-executor-node.ts
  packages/quereus/src/planner/nodes/returning-node.ts
  packages/quereus/src/planner/nodes/constraint-check-node.ts
  packages/quereus/src/planner/nodes/add-constraint-node.ts
  packages/quereus/src/planner/nodes/create-table-node.ts
  packages/quereus/src/planner/nodes/create-view-node.ts
  packages/quereus/src/planner/nodes/create-index-node.ts
  packages/quereus/src/planner/nodes/create-assertion-node.ts
  packages/quereus/src/planner/nodes/drop-table-node.ts
  packages/quereus/src/planner/nodes/drop-view-node.ts
  packages/quereus/src/planner/nodes/drop-assertion-node.ts
  packages/quereus/src/planner/nodes/alter-table-node.ts
  packages/quereus/src/planner/nodes/declarative-schema.ts
----
## Findings

### smell: DDL nodes inconsistently extend PlanNode+VoidNode(interface) instead of VoidNode(class)
file: multiple (create-assertion-node.ts, drop-assertion-node.ts, add-constraint-node.ts, alter-table-node.ts, declarative-schema.ts)
Six DDL nodes duplicate getType(), getChildren(), withChildren() boilerplate that VoidNode abstract class already provides. Other DDL nodes correctly extend VoidNode. This is a DRY violation creating maintenance burden.
Ticket: tickets/plan/ddl-void-node-inheritance-cleanup.md

### note: ConstraintCheckNode uses magic numbers for RowOpFlag
file: packages/quereus/src/planner/nodes/constraint-check-node.ts:116
toString() and getLogicalAttributes() use literal 1, 2, 4 instead of RowOpFlag.INSERT/UPDATE/DELETE. Currently blocked by const enum + type import semantics. Addressed in the refactoring ticket.

### note: InsertNode.getAttributes() inline logic vs shared utility
file: packages/quereus/src/planner/nodes/insert-node.ts:31
InsertNode has inline flat-descriptor attribute building with proper column types/names, while UpdateNode/DeleteNode delegate to buildAttributesFromFlatDescriptor() which produces generic TEXT attributes with synthetic names. The inconsistency is minor since InsertNode's approach is more correct; the shared utility could be enhanced in a future pass.

### note: DropTableNode uses eslint-disable + `as any` cast
file: packages/quereus/src/planner/nodes/drop-table-node.ts:29
expressionToString(this.statementAst as any) — the function expects AST.Expression but receives a DropStmt. Noted in the refactoring ticket.

## Trivial Fixes Applied
- dml-executor-node.ts:92 — removed redundant `as RelationalPlanNode` cast (already narrowed by type guard)
- declarative-schema.ts:DeclareSchemaNode.withChildren — added child count validation and return `this` (was always creating new instance)
- declarative-schema.ts:DiffSchemaNode.withChildren — added child count validation and return `this`
- declarative-schema.ts:ApplySchemaNode.withChildren — added child count validation and return `this`
- declarative-schema.ts:ExplainSchemaNode.withChildren — added child count validation and return `this`
- declarative-schema.ts:DiffSchemaNode.getAttributes — cached via Cached<> to prevent unstable attribute ID generation on repeated calls
- declarative-schema.ts:ExplainSchemaNode.getAttributes — cached via Cached<> to prevent unstable attribute ID generation on repeated calls

## No Issues Found
- insert-node.ts — clean (well-structured, proper withChildren identity check)
- update-node.ts — clean (proper assignment child tracking, good withChildren)
- delete-node.ts — clean (proper structure, good identity checks)
- returning-node.ts — clean (good caching, attribute ID preservation in withChildren)
- create-table-node.ts — clean (extends VoidNode correctly)
- create-view-node.ts — clean (extends VoidNode correctly, IF NOT EXISTS handled)
- create-index-node.ts — clean (extends VoidNode correctly)
- drop-view-node.ts — clean (extends VoidNode correctly, IF EXISTS handled)

## Testing
Comprehensive SQL logic tests exist covering all DDL/DML operations: INSERT, UPDATE, DELETE, RETURNING, constraints, ON CONFLICT/UPSERT, ALTER TABLE, CREATE/DROP TABLE/VIEW, declarative schema, and assertions. Build passes. 472 tests pass (1 pre-existing failure in unrelated key-propagation test).
