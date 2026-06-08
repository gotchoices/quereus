description: Review of core infrastructure (Database, Statement, connections, common types)
files:
  packages/quereus/src/core/database.ts
  packages/quereus/src/core/database-assertions.ts
  packages/quereus/src/core/database-events.ts
  packages/quereus/src/core/database-internal.ts
  packages/quereus/src/core/database-options.ts
  packages/quereus/src/core/database-transaction.ts
  packages/quereus/src/core/param.ts
  packages/quereus/src/core/statement.ts
  packages/quereus/src/core/utils.ts
  packages/quereus/src/common/constants.ts
  packages/quereus/src/common/datatype.ts
  packages/quereus/src/common/errors.ts
  packages/quereus/src/common/json-types.ts
  packages/quereus/src/common/logger.ts
  packages/quereus/src/common/type-inference.ts
  packages/quereus/src/common/types.ts
  packages/quereus/src/index.ts
----
## Findings

### defect: onChange validation errors swallowed in DatabaseOptionsManager
file: packages/quereus/src/core/database-options.ts:247
`notifyListener()` catches and logs errors from onChange handlers. Since `setOption()` stores the new value before calling notifyListener, validation errors (e.g., `default_column_nullability` rejecting invalid values) are silently swallowed and the invalid value persists.
Ticket: tickets/fix/options-onchange-error-swallowed.md

### smell: _evalGenerator double-parses SQL for multi-statement batches
file: packages/quereus/src/core/database.ts:1217
In the multi-statement branch of `_evalGenerator`, SQL is re-parsed via `_parseSql(sql)` even though `stmt.astBatch` already contains the parsed AST from `prepare()`. Wastes CPU and introduces a theoretical divergence risk.
Ticket: tickets/fix/eval-generator-double-parse.md

### note: registerConnection swallows begin() errors
file: packages/quereus/src/core/database.ts:1380
If starting a transaction on a newly registered connection fails, the error is logged but swallowed. The connection remains registered without an active transaction while the system expects one. The comment explains the rationale ("avoid breaking connection registration") but this could mask data integrity issues.
Ticket: none (design decision, documented)

### note: disableLogging() disables all debug namespaces
file: packages/quereus/src/common/logger.ts:76
`debug.disable()` is global — it disables logging for all libraries using the `debug` package, not just quereus. Could surprise users who also use debug-based logging in their app.
Ticket: none (minor, documented)

### note: QuereusError missing Object.setPrototypeOf
file: packages/quereus/src/common/errors.ts:7
`ConstraintError` and `MisuseError` both call `Object.setPrototypeOf(this, ...)` but their base class `QuereusError` does not. Minor inconsistency; unlikely to cause issues with modern ES module targets.
Ticket: none (no practical impact)

## Trivial Fixes Applied
- database.ts:334-340 — removed orphaned duplicate JSDoc for `exec()` method that was separated from the actual method by a section divider
- statement.ts:572-592 — fixed indentation in `validateParameterTypes()`: physical type checking block was one tab short of its enclosing `for` loop

## No Issues Found
- database-assertions.ts — clean: proper caching, schema invalidation, resource cleanup in dispose()
- database-events.ts — clean: savepoint layering, listener leak detection, proper cleanup
- database-internal.ts — clean: well-documented interface
- database-transaction.ts — clean: proper commit/rollback coordination, savepoint management
- param.ts — clean
- utils.ts — clean
- common/constants.ts — clean
- common/datatype.ts — clean
- common/json-types.ts — clean
- common/type-inference.ts — clean
- common/types.ts — clean: proper type guards, isSqlValue validation
- index.ts — clean: comprehensive exports
