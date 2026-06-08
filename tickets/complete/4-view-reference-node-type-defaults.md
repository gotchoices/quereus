description: Deleted dead ViewReferenceNode — never instantiated, all three original defects were moot
prereq: none
files:
  packages/quereus/src/planner/nodes/view-reference-node.ts (deleted)
  packages/quereus/src/planner/building/select.ts (actual view handling, unchanged)
  packages/quereus/src/planner/type-utils.ts (already handles isReadOnly for views)
----
## Summary

ViewReferenceNode was dead code — never imported, instantiated, emitted, or exported. The three
original defects (wrong nodeType, TEXT defaults, isReadOnly=false) existed only in the dead code
path and never affected runtime behavior. The file was deleted.

The actual view handling in `select.ts` inlines the view's SELECT AST via `buildSelectStmt()`,
which correctly inherits column types from underlying tables. `relationTypeFromTableSchema()` in
`type-utils.ts` already sets `isReadOnly: true` for views.

## What changed

- Deleted `packages/quereus/src/planner/nodes/view-reference-node.ts`

## Review results

- No remaining imports or references to ViewReferenceNode in the codebase
- View handling in `select.ts:343-396` is the sole and correct code path
- `type-utils.ts:47` correctly sets `isReadOnly` for views
- Build passes
- All 1013 tests pass (12 view-specific tests pass)
