description: Review of CTE and subquery plan nodes
files:
  packages/quereus/src/planner/nodes/cte-node.ts
  packages/quereus/src/planner/nodes/cte-reference-node.ts
  packages/quereus/src/planner/nodes/recursive-cte-node.ts
  packages/quereus/src/planner/nodes/internal-recursive-cte-ref-node.ts
  packages/quereus/src/planner/nodes/subquery.ts
----
## Findings

### defect: CTENode.buildAttributes() uses name-based instead of positional column mapping
file: packages/quereus/src/planner/nodes/cte-node.ts:60-86
When explicit CTE column names differ from source query column names (e.g., `WITH cte(x,y) AS (SELECT a,b ...)`), the name-based lookup fails and all columns fall back to TEXT type. RecursiveCTENode correctly uses positional mapping.
Ticket: tickets/fix/cte-node-positional-column-mapping.md

### defect: Recursive CTE emitter termination check broken for unlimited recursion
file: packages/quereus/src/runtime/emit/recursive-cte.ts (safety check after while loop)
When `maxIterations=0` (unlimited), the post-loop guard `iterationCount >= maxIterations` is always true, causing a spurious error even when the CTE terminates naturally.
Ticket: tickets/fix/recursive-cte-termination-unlimited.md

### smell: InNode.getType() returned nullable: false despite three-valued logic
file: packages/quereus/src/planner/nodes/subquery.ts:103
SQL IN with NULLs can return NULL (e.g., `5 IN (1, NULL)` → NULL). The emitter correctly implements this, but the type claimed non-nullable.
Ticket: fixed in review

### smell: InNode.comparator was dead code
file: packages/quereus/src/planner/nodes/subquery.ts:90-101
The `comparator` property was allocated in the constructor but never used — the emitter uses `compareSqlValuesFast` with collation instead. Removed along with unused imports (`CompareFn`, `compareSqlValues`).
Ticket: fixed in review

### smell: RecursiveCTENode.buildType() always set isSet: false
file: packages/quereus/src/planner/nodes/recursive-cte-node.ts:74
UNION DISTINCT deduplicates, so `isSet` should be `true` in that case. Changed to `!this.isUnionAll`.
Ticket: fixed in review

### note: CTE materialization hint doesn't share results across references
The CTE emitter materializes rows within a single execution, but each CTEReferenceNode re-emits the source CTE independently. Multiple references to the same CTE re-execute the query rather than sharing materialized results. This is a performance optimization opportunity, not a correctness issue.

### note: RecursiveCTENode.setRecursiveCaseQuery() mutates an otherwise-immutable plan node
Justified for breaking the circular dependency during planning. The builder creates the node, then sets the recursive case after building it (since the recursive case references the node's own tableDescriptor). `withChildren()` properly creates new instances.

## Trivial Fixes Applied
- subquery.ts: Removed dead `comparator` property, `CompareFn` type import, and `compareSqlValues` import from InNode
- subquery.ts:103: Changed InNode.getType() `nullable: false` → `nullable: true`
- recursive-cte-node.ts:74: Changed `isSet: false` → `isSet: !this.isUnionAll`

## No Issues Found
- cte-reference-node.ts — clean (proper attribute ID preservation across rewrites, correct withChildren)
- internal-recursive-cte-ref-node.ts — clean (proper working table lookup via tableDescriptor)
- ExistsNode — clean (nullable: false is correct for EXISTS, short-circuit in emitter is correct)
- ScalarSubqueryNode — clean (multiple-row error in emitter, type derivation from first column)
