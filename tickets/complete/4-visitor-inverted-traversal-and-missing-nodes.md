description: Fixed AST visitor inverted traversal logic and added missing node type handlers
files:
  packages/quereus/src/parser/visitor.ts
  packages/quereus/test/visitor.spec.ts
----
### What was built

Fixed three issues in the AST visitor (`traverseAst`):

1. **Inverted traversal control flow** — `result !== false` was changed to `result === false` on both
   `enterNode` and specific visitor callbacks so that returning `false` stops the branch and
   `void`/`true` continues (matching documented behavior).

2. **Missing expression node handlers** — Added switch cases for `case`, `in`, `exists`, `between`,
   and `mutatingSubquerySource` with correct child traversal.

3. **CTE traversal** — Added `withClause?.ctes` traversal to `select`, `insert`, `update`, and
   `delete` cases.

Also added `analyze` and `declareSchema` to the DDL no-op list.

### Testing

14 tests in `test/visitor.spec.ts`:
- Traversal control flow: void/true continues, false stops branch, enterNode false prevents exitNode
- Specific visitor false stops branch traversal
- exitNode called after children
- CASE, IN (values + subquery), EXISTS, BETWEEN expression traversal
- CTE traversal in SELECT with WITH clause
- Graceful handling of undefined nodes

### Notes

Pre-existing gaps remain (not introduced by this change):
- `insert` doesn't traverse `upsertClauses` or `returning`
- `update`/`delete` don't traverse `returning`
- ~25 AST node types (constraints, schema declarations, window frame bounds) not in the switch
- Visitor not exported from parser/index.ts (internal-only utility)
