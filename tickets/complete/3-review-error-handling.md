---
description: Error handling standardization - audit and fixes across the Quereus codebase
prereq: none

---

# Error Handling Review - Implementation Summary

## Changes Made

### 1. Error Class Hierarchy Fixes (`src/common/errors.ts`)

- **Removed unused `SyntaxError` class** - Was never instantiated, shadowed the built-in JavaScript `SyntaxError`, and was not exported from `index.ts`. The parser has its own `ParseError` class.
- **`ConstraintError`** - Added `cause?: Error` parameter forwarding to base class. Previously only accepted `(message, code)`, losing error chain information.
- **`MisuseError`** - Added `cause?: Error` parameter forwarding to base class. Previously only accepted `(message)`, losing error chain information.

### 2. ParseError Hierarchy Fix (`src/parser/parser.ts`)

- **`ParseError` now extends `QuereusError`** instead of `Error`. This gives parser errors:
  - A proper `StatusCode.ERROR` status code
  - Line/column from the token's `startLine`/`startColumn`
  - `instanceof QuereusError` support
  - Participation in the error chain and formatting system

### 3. User-Facing Error Type Fixes

- **`planner/building/drop-assertion.ts`** - Replaced `throw new Error(...)` with `quereusError(...)`, passing the AST `stmt` for location info.
- **`planner/analysis/const-evaluator.ts`** - Replaced both `throw new Error(...)` with `throw new QuereusError(...)`, preserving original errors as `cause`.
- **`core/database.ts`** - Changed parser error wrapping from `new Error(String(err))` to `new QuereusError(...)`, preserving original error as `cause`.

### 4. Location Info Enhancement (`src/runtime/emit/`)

- **`unary.ts`** and **`binary.ts`** - Switched from `throw new QuereusError(...)` to `quereusError(...)` with AST expression nodes, adding source location to all "unsupported operator" errors.

### 5. Additional Error Tests (`test/logic/90-error_paths.sqllogic`)

Added tests for:
- Multi-line parse errors with location info
- NOT NULL constraint via UPDATE to NULL
- CHECK constraint violations

## Audit Findings

### `throw new Error(...)` Usage (33 instances found)
- **5 user-facing** - Fixed (see above)
- **28 internal validation** - Left as `Error` (planner node `withChildren()` assertions). These are internal programming errors, not user-facing.

### Error Swallowing Patterns (60+ catch blocks reviewed)
- **All are intentional** - SQL semantics (return null on error for JSON/temporal functions), best-effort cleanup, graceful degradation with logging.
- No true error-swallowing bugs found. The codebase follows the project rule well.

### Remaining Architecture Notes
- The `quereusError()` helper is the preferred way to throw errors when AST nodes are available (auto-extracts location). Some planner files use direct `new QuereusError(...)` with manual `expr.loc?.start.line` extraction; consider migrating these to `quereusError()` for consistency in a future pass.
- Internal plan node `withChildren()` validation errors use `throw new Error(...)` which is appropriate (these indicate programming errors, not user-facing issues).

## Validation

- Full test suite passes (0 failures)
- No linter errors
- Error path sqllogic tests expanded and passing

## TODO

- [ ] Verify `ParseError` extends `QuereusError` works correctly with error formatting utilities
- [ ] Verify `ConstraintError` cause chain works in deferred constraint scenarios
- [ ] Verify error tests cover multi-line parse errors and constraint violations
- [ ] Consider future pass to standardize direct `new QuereusError(...)` with location extraction to use `quereusError()` helper
