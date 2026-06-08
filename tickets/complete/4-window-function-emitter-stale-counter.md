description: Removed dead standalone window function emitter
prereq: none
files:
  packages/quereus/src/runtime/emit/window-function.ts (deleted)
  packages/quereus/src/runtime/register.ts (import + registration removed)
----
## Summary

Removed the unreachable `emitWindowFunctionCall` standalone emitter. `WindowFunctionCallNode` is never independently emitted — it's always handled inline by `emitWindow` via `WindowNode`. The standalone emitter in `window-function.ts` was dead code.

## What Changed

- **Deleted** `packages/quereus/src/runtime/emit/window-function.ts`
- **Removed** import and `registerEmitter(PlanNodeType.WindowFunctionCall, ...)` from `register.ts`
- **Kept** `PlanNodeType.WindowFunctionCall` enum value and `WindowFunctionCallNode` class (used by planner, characteristics detector, and `emitWindow`)

## Review Verification

- Build passes cleanly
- Full test suite: 1013 passing, 2 pending, 0 failures
- No references to `emitWindowFunctionCall` remain in codebase
- No runtime emit code references `PlanNodeType.WindowFunctionCall` — confirmed dead code
- `emitWindow` in `window.ts` handles all window function types inline (ranking, aggregate, navigation, value) through `WindowNode.functions`
- All window functions (ROW_NUMBER, RANK, DENSE_RANK, LAG, LEAD, FIRST_VALUE, LAST_VALUE, NTILE, PERCENT_RANK, CUME_DIST) and frame clauses covered by existing sqllogic and planner tests
