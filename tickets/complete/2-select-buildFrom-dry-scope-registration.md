description: Extracted repeated scope registration pattern in buildFrom into registerColumnScope helper
files:
  packages/quereus/src/planner/building/select.ts
----
## What was done

Extracted the repeated 6-line scope-registration-plus-aliasing pattern (RegisteredScope → register columns → AliasedScope) in `buildFrom` into a file-private `registerColumnScope` helper at `select.ts:254`. Five call sites replaced:

1. Internal recursive CTE reference
2. Regular CTE reference
3. View
4. Regular table
5. Function source

Subquery and mutating-subquery cases intentionally left inline — they have column-name overrides, bounds checking, type fallback, and conditional AliasedScope wrapping.

## Key interface

```ts
function registerColumnScope(
  parentScope: Scope,
  node: RelationalPlanNode,
  scopeName: string,
  alias: string,
): Scope
```

## Testing

Pure refactoring — no behavioral change. All existing tests pass (`yarn build` + `yarn test`). Coverage via SQL logic tests (FROM with tables, views, CTEs, joins, table functions), planner tests, and virtual table tests.
