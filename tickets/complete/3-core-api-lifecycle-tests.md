---
description: Core API lifecycle and cleanup tests for Database and Statement
prereq: none
---

# Core API Lifecycle Tests

Added `packages/quereus/test/lifecycle.spec.ts` covering lifecycle guard rails for the core API classes.

## What Was Added

### Database Lifecycle (7 tests)
- `close()` idempotency — double-close doesn't throw
- `close()` finalizes outstanding prepared statements
- `exec()`, `prepare()`, `get()`, `eval()` all throw `MisuseError` after close
- Statements prepared before close reject subsequent operations

### Statement Lifecycle (8 tests)
- `finalize()` idempotency — double-finalize doesn't throw
- `run()`, `get()`, `all()`, `iterateRows()`, `bind()` all throw `MisuseError` after finalize
- Statement reuse after error via `reset()` — confirms a prepared statement can recover from a constraint violation and execute again with different parameters
- Finalized statement is properly removed from the database's statement tracking set

## What Was Intentionally Omitted

- **Iterator cleanup tests**: Already comprehensively covered in `statement-iterator-cleanup.spec.ts` (normal completion, early exit, error, mutex release, direct `return()`/`throw()`)
- **Return value tests for `exec()`/`run()`**: Both return `Promise<void>` — no `lastInsertRowid` or `changes` values to test
- **Transaction isolation tests**: Already well-covered in `test/logic/04-transactions.sqllogic`

## Validation

All 15 new tests pass. Full suite (259 tests) passes with zero regressions.

## Key Files
- `packages/quereus/test/lifecycle.spec.ts` — the new test file
- `packages/quereus/src/core/database.ts` — `close()`, `checkOpen()`
- `packages/quereus/src/core/statement.ts` — `finalize()`, `validateStatement()`, `reset()`
