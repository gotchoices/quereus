---
description: Fix error handling inconsistencies (ParseError, inline require, logging)
prereq: none

---

# Fix Error Handling Consistency

Three consistency issues addressed across the core API and event system.

## Changes

### 1. ParseError Re-thrown Directly
**File:** `packages/quereus/src/core/database.ts`

`Database._parseSql()` previously wrapped `ParseError` in a generic `QuereusError`, discarding line/column location info. Now re-throws `ParseError` directly, preserving its full context since it already extends `QuereusError`.

### 2. Inline `require()` Replaced with Top-Level Import
**File:** `packages/quereus/src/core/database.ts`

`Database.registerType()` used an inline `require('../types/registry.js')`. Replaced with a top-level ES module import (`registerTypeInRegistry`). Also fixed a latent bug where the method passed `(name, definition)` to a single-argument function; now correctly passes only `definition`.

### 3. `console.error` Replaced with Project Logger
**Files:**
- `packages/quereus/src/core/database-events.ts`
- `packages/quereus/src/vtab/events.ts`

All `console.error` calls in event listener error handlers replaced with `errorLog` (via `createLogger().extend('error')`). Error messages now include event context (table name, operation type, etc.) for debugging.

## Testing

- All 238 Mocha tests pass
- All 49 node:test tests pass (including event system tests)
- The `Listener Error Handling` test in the event system suite validates that listener errors don't halt event dispatch
- No circular dependency issues with the new top-level import

## Validation

- Confirm `ParseError` from malformed SQL still includes line/column in error output
- Confirm `registerType` still registers custom types correctly
- Confirm event listener errors are captured by the debug logger (`DEBUG=quereus:*:error`)
