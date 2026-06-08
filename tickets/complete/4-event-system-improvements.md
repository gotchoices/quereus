---
description: Event system memory management and documentation improvements
prereq: none
---

# Event System Improvements

## Changes Made

### Listener Management (`database-events.ts`)

- **Max listener warning**: `DatabaseEventEmitter` now tracks a configurable `maxListeners` threshold (default 100). When `onDataChange()` or `onSchemaChange()` adds a listener that exceeds the limit, a warning is logged via the `warn` debug channel. This mirrors Node.js `EventEmitter` behaviour and catches accidental listener leaks early.
  - `setMaxListeners(n)` — adjust or disable (`0`) the warning threshold.
  - `getMaxListeners()` — read the current limit.
- **Warning on removeAllListeners()**: If any listeners are still registered when `removeAllListeners()` is called (e.g. during `db.close()`), a warning is logged with the counts, signalling that consumer code may have forgotten to unsubscribe.

### Documentation (`docs/module-authoring.md`)

Two new subsections added under the existing "Event Semantics" section:

- **Event Ordering Guarantees** — documents that schema events are emitted before data events on flush, savepoint events are flattened, and cross-category chronological order is not preserved.
- **Listener Memory Management** — best practices: always unsubscribe, clean up before discarding Database, and use `setMaxListeners()` when legitimate high listener counts are expected.

## Validation

- All 244 Mocha + 49 node test runner tests pass (0 failures).
- No linter errors introduced.
- Existing event system test suites (`Database-Level Event System`, `VTable Event Hooks`) continue to pass, confirming no regressions in subscription, batching, savepoint, or error-handling behaviour.

## Key Files

- `packages/quereus/src/core/database-events.ts` — implementation
- `docs/module-authoring.md` — documentation
