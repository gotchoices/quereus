description: Fix TIMESPAN multiplication/division for calendar-unit durations (months, years, weeks)
files:
  packages/quereus/src/runtime/emit/temporal-arithmetic.ts
  packages/quereus/test/logic/15-timespan.sqllogic
----

## What was built
Fixed `tryTemporalArithmetic` to handle calendar-unit durations (years, months, weeks) in multiply/divide
operations. Previously, these operations converted to total seconds via `Temporal.Duration.total()`,
which throws for calendar units, causing the catch to silently return `null`.

Three helper functions added:
- `hasCalendarUnits(d)` — detects years/months/weeks fields
- `scaleDuration(d, factor)` — field-by-field multiplication
- `divideDuration(d, divisor)` — integer division with remainder cascading (years→months×12, weeks→days×7, etc.; months→days gap is truncated)

Calendar-unit TIMESPAN/TIMESPAN ratio returns `null` (undefined without a reference date).

## Testing
All 7 ticket-specified cases pass plus an additional test for calendar-unit ratio returning null:
- `timespan('P2M') * 3` → `P6M`
- `timespan('P1Y6M') * 2` → `P2Y12M`
- `4 * timespan('P3M')` → `P12M`
- `timespan('P1Y6M') / 2` → `P9M`
- `timespan('P6M') / 3` → `P2M`
- `timespan('P1Y2M3DT4H') * 2` → `P2Y4M6DT8H`
- `timespan('P2Y4M6DT8H') / 2` → `P1Y2M3DT4H`
- `timespan('P6M') / timespan('P2M')` → `null`

All existing timespan tests continue to pass (329 passing, 1 pre-existing unrelated failure in DDL lifecycle).
