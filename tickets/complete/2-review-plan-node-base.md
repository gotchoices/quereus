description: Review of plan node base classes and scalar expressions
files:
  packages/quereus/src/planner/nodes/plan-node.ts
  packages/quereus/src/planner/nodes/plan-node-type.ts
  packages/quereus/src/planner/nodes/scalar.ts
----
## Findings

### defect: visit() and getTotalCost() double-traverse relational children
file: packages/quereus/src/planner/nodes/plan-node.ts:168-172
Both methods iterate `getChildren()` and `getRelations()`, but for relational nodes and subquery nodes, relational children appear in both — causing double-visiting and double-counting.
Ticket: tickets/fix/plan-node-visit-double-traversal.md

### defect: NOT operator incorrectly marked non-nullable
file: packages/quereus/src/planner/nodes/scalar.ts:34-38
`NOT NULL` evaluates to `NULL` in SQL three-valued logic, but the code grouped NOT with IS NULL/IS NOT NULL and set `nullable = false`. NOT should preserve operand nullability.
Ticket: fixed in review

### defect: IS/IS NOT operators missing non-nullable annotation
file: packages/quereus/src/planner/nodes/scalar.ts:144-145
`IS`/`IS NOT` are null-safe comparisons that never return NULL (`NULL IS NULL` → TRUE), but nullable was derived from operand types. Now explicitly set to `false`.
Ticket: fixed in review

### defect: BetweenNode incorrectly hardcodes nullable: false
file: packages/quereus/src/planner/nodes/scalar.ts:713
`NULL BETWEEN 1 AND 10` evaluates to NULL in SQL (BETWEEN is equivalent to `>=` AND `<=`). Now derives nullability from operand types.
Ticket: fixed in review

### smell: TernaryScalarBase.withChildren() silently returns this
file: packages/quereus/src/planner/nodes/plan-node.ts:474-479
The base class `withChildren()` validated arity but always returned `this`, ignoring new children. No concrete subclasses currently use it (BetweenNode extends PlanNode directly), but it would silently break any future user. Made abstract to match UnaryScalarBase/BinaryScalarBase/NaryScalarBase.
Ticket: fixed in review

### note: PhysicalProperties.ordering JSDoc mismatch
file: packages/quereus/src/planner/nodes/plan-node.ts:13
Comment said "negative for DESC" but the actual type uses `{ column: number; desc: boolean }`. Updated comment.
Ticket: fixed in review

### note: 7 PlanNodeType enum values have no concrete implementations
file: packages/quereus/src/planner/nodes/plan-node-type.ts
Unused values: `TableSeek`, `NestedLoopJoin`, `Materialize`, `IsNull`, `IsNotNull`, `Like`, `Savepoint`, `DropIndex`. These appear to be stubs for planned features. DropIndex has no corresponding node file.

## Trivial Fixes Applied
- plan-node.ts:13 — Updated ordering JSDoc from "negative for DESC" to match actual type
- plan-node.ts:474-479 — Made TernaryScalarBase.withChildren() abstract
- scalar.ts:34-38 — Separated NOT from IS NULL/IS NOT NULL in nullability handling
- scalar.ts:135-148 — Added nullable tracking variable to BinaryOpNode, IS/IS NOT set to false
- scalar.ts:713 — BetweenNode derives nullable from operand types instead of hardcoding false

## No Issues Found
- plan-node-type.ts — clean (aside from stubs noted above)
- plan-node.ts base class hierarchy, clone semantics, child traversal interfaces — clean
- Scalar node withChildren() implementations — all properly validate arity, check identity, return new instances
- CaseExprNode complex child reconstruction — correctly maps positional children back to when/then/else
- Type inference for arithmetic, string concat, cast, collate — correct
