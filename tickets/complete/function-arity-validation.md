description: Reject function calls whose argument count doesn't match any registered overload. Re-registered `round` as two explicit overloads (round/1, round/2) so `round(1.5, 2, 3)` falls through to the existing "Function not found" path that abs/length already used.
files: packages/quereus/src/func/builtins/scalar.ts, packages/quereus/src/func/builtins/index.ts, packages/quereus/test/logic/10.3-function-features.sqllogic
----

# Function arity validation — complete

## What was built

Three arity-mismatch assertions in `packages/quereus/test/logic/10.3-function-features.sqllogic:65-79` now all produce "Function not found":

- `select abs(1, 2);` (already worked)
- `select length();` (already worked)
- `select round(1.5, 2, 3);` (this fix)

The `round/3` case slipped through before because `round` was registered with `numArgs: -1` (variadic), so the dispatcher's variadic fallback in `packages/quereus/src/planner/building/schema-resolution.ts:140-152` caught it and dispatched to the variadic impl, which silently ignored the extra argument.

## Implementation

`packages/quereus/src/func/builtins/scalar.ts`
- Replaced the single variadic `roundFunc` with `roundImpl` (shared body) + `roundSchemaBase` (shared schema fragment) + two exports `roundFunc1` (numArgs=1) and `roundFunc2` (numArgs=2).
- Same overload-pair pattern as `pow`/`power` and `ceil`/`ceiling`.

`packages/quereus/src/func/builtins/index.ts`
- Updated import and `BUILTIN_FUNCTIONS` entry to register both overloads.

No planner-level change needed — the dispatcher already throws `Function not found: ${funcName}/${numArgs}` when both the exact-arity lookup and the variadic fallback miss.

## Validation

- Targeted assertion in `10.3-function-features.sqllogic` passes.
- 2453 quereus tests pass (49s).
- Lint clean (0 errors; pre-existing warnings only).

## Out of scope (parked)

- `substr`/`substring` are also registered as `numArgs: -1` but conceptually only accept 2-3 args. No corpus assertion currently covers `substr/4`+. If a future test fails for `substr(a, b, c, d)`, apply the same overload-split treatment.
- A general `minArgs`/`maxArgs` schema field would express bounded-variadic functions more cleanly; deferred as larger scope.

## Downstream

Lamina's `lamina-quereus-test` `KNOWN_FAILURES` list contains a `FUNCTION_ARITY_VALIDATION` entry — once lamina consumes the new quereus version, that entry should be removed.
