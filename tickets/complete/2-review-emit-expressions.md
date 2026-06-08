description: Review of runtime emitters for expressions and scalar operations
files:
  packages/quereus/src/runtime/emit/binary.ts
  packages/quereus/src/runtime/emit/unary.ts
  packages/quereus/src/runtime/emit/cast.ts
  packages/quereus/src/runtime/emit/case.ts
  packages/quereus/src/runtime/emit/between.ts
  packages/quereus/src/runtime/emit/collate.ts
  packages/quereus/src/runtime/emit/parameter.ts
  packages/quereus/src/runtime/emit/scalar-function.ts
  packages/quereus/src/runtime/emit/temporal-arithmetic.ts
----
## Findings

### defect: BETWEEN ignores operand collation
file: packages/quereus/src/runtime/emit/between.ts:10
`emitBetween` hardcodes `ctx.resolveCollation('BINARY')` instead of checking
operand types for collation names. Unlike `emitComparisonOp` in binary.ts which
correctly resolves collation from operand types, BETWEEN always uses BINARY.
Ticket: tickets/fix/between-ignores-collation.md

### defect: Mixed bigint/number arithmetic returns null
file: packages/quereus/src/runtime/emit/binary.ts:93
When one operand is bigint and the other is number (e.g., large INTEGER + REAL),
`innerBigInt()` is called with mixed types causing TypeError, caught by try/catch
returning null instead of performing numeric arithmetic.
Ticket: tickets/fix/bigint-number-mixed-arithmetic-null.md

### defect: TIMESPAN multiplication fails for calendar-unit durations
file: packages/quereus/src/runtime/emit/temporal-arithmetic.ts:192
`duration.total({ unit: 'seconds' })` throws for durations with years/months/weeks
when no `relativeTo` is provided. Caught and returns null silently.
Ticket: tickets/fix/timespan-multiply-calendar-units-null.md

### smell: Duplicated bigint/number arithmetic logic
file: packages/quereus/src/runtime/emit/binary.ts:92-162
Three run-function variants (runTemporalArithmetic, runNumericOnly,
runGenericArithmetic) contain nearly identical bigint/number dispatch logic.
Could be extracted into a shared helper.

### note: CASE does not short-circuit evaluation
file: packages/quereus/src/runtime/emit/case.ts:71
All WHEN/THEN expressions are eagerly evaluated before the run function executes.
Already acknowledged by TODO comment in the code.

### note: DATE-DATETIME subtraction loses time precision
file: packages/quereus/src/runtime/emit/temporal-arithmetic.ts:82
Subtracting two datetimes converts both to PlainDate first, losing time-of-day
information from the result.

### note: castFallback missing temporal type entries
file: packages/quereus/src/runtime/emit/cast.ts:41
`castFallback` handles INTEGER, REAL, NUMERIC, TEXT, BLOB but not BOOLEAN or
temporal types (DATE, TIME, DATETIME, TIMESPAN). The default case returns the
original value unchanged.

## Trivial Fixes Applied
- case.ts:11,40 — Removed unnecessary `async`/`Promise` from `runSimpleCase` and
  `runSearchedCase` (never await; avoids promise wrapping overhead in hot path)
- scalar-function.ts:42 — Removed unnecessary `[...operandExprs]` spread
  (`map()` already returns a new array)

## No Issues Found
- unary.ts — clean (proper null handling, operator dispatch, temporal duration negation)
- collate.ts — clean (correct no-op passthrough; collation is type-level metadata)
- parameter.ts — clean (proper named/indexed lookup, clear error messages)
