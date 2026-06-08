---
description: Extract repeated transaction finalization pattern into helper
prereq: none

---

# DRY: Transaction Finalization Pattern

## Summary

Added `_finalizeImplicitTransaction(success: boolean)` to the `Database` class, consolidating 5 occurrences of the implicit-transaction commit/rollback pattern into a single method.

### Method

`Database._finalizeImplicitTransaction(success)` checks if an implicit transaction is active and commits or rolls back accordingly. No-op when no implicit transaction exists.

### Call Sites Updated

- `Statement.iterateRows()` — callback in `wrapAsyncIterator`
- `Statement.run()` — try/finally block
- `Statement.get()` — try/finally block
- `Statement.all()` — callback in `wrapAsyncIterator`
- `Database.eval()` — callback in `wrapAsyncIterator`

### Key Files

- `packages/quereus/src/core/database.ts` — new method, updated `eval()`
- `packages/quereus/src/core/statement.ts` — updated `iterateRows()`, `run()`, `get()`, `all()`

## Testing

- Full test suite passes (244 Mocha + 49 Node tests, 0 failures).
- The `Statement Iterator Cleanup` test suite directly exercises all affected call sites (normal completion, early exit, error rollback) and continues to pass.

## Validation

- `_isImplicitTransaction()` is no longer referenced from `statement.ts`.
- No lint errors introduced.
