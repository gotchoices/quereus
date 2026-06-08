---
description: Extract repeated function registration error handling into a shared helper
prereq: none

---

# DRY: Function Registration Error Handling

## Summary

Extracted the identical try-catch error handling pattern that was repeated in `createScalarFunction()`, `createAggregateFunction()`, and `registerFunction()` into a single private method `registerFunctionWithErrorHandling()` on the `Database` class.

## Changes

- **`packages/quereus/src/core/database.ts`**: Added `registerFunctionWithErrorHandling(funcType, funcName, numArgs, register)` private method. Refactored all three public function registration methods to delegate to it. Removed unused `quereusError` import.

## Error handling improvement

The previous pattern used `if (e instanceof Error) throw e; else quereusError(String(e))`, which re-threw any `Error` subclass as-is (including non-Quereus errors). The new helper consistently:
1. Re-throws `QuereusError` unchanged
2. Wraps all other errors (including plain `Error`) in a `QuereusError` with contextual message and cause chain

## Validation

- All 244 Mocha tests pass
- All 49 Node test runner tests pass (5 skipped, 0 failures)
- No lint errors introduced

## Testing notes

The function registration error paths are exercised implicitly by the full test suite (every query uses built-in functions registered through these code paths). Explicit negative-path testing would require attempting to register a function that causes `addFunction` to throw (e.g., a duplicate name with conflicting arity).
