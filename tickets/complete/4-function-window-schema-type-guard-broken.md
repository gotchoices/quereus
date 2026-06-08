description: Removed dead WindowFunctionSchema from function.ts union, fixed classifyFunction to use window registry
files:
  packages/quereus/src/schema/function.ts
  packages/quereus/src/schema/window-function.ts
  packages/quereus/src/func/builtins/schema.ts
  packages/quereus/test/function-type-guards.spec.ts
----
## What was done

The `WindowFunctionSchema` interface in `function.ts` was runtime-indistinguishable from `ScalarFunctionSchema`, making its type guard always return `false`. The actual window function system uses a separate registry in `window-function.ts`.

- Removed the dead `WindowFunctionSchema` interface, union membership, and broken type guard from `function.ts`
- Fixed `classifyFunction` in `schema.ts` to check the window function registry first via `isWindowFunction(name)`
- Exported `classifyFunction` for testability

## Testing

- `function-type-guards.spec.ts`: 8 passing tests covering all type guards and `classifyFunction` (scalar, TVF, aggregate, window)
- Window test registers a function in the registry and confirms a scalar-shaped schema with that name is classified as `'window'`
- TypeScript type check: clean
- Full test suite: 1013 passing, 0 failures
