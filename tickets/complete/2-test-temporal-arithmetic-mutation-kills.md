description: Review temporal arithmetic mutation-killing tests for binary.ts and temporal-arithmetic.ts
prereq: none
files:
  packages/quereus/src/runtime/emit/binary.ts
  packages/quereus/src/runtime/emit/temporal-arithmetic.ts
  packages/quereus/src/types/temporal-types.ts
  packages/quereus/test/runtime/temporal-arithmetic.spec.ts
  packages/quereus/test/logic/107-temporal-arithmetic-mutation-kills.sqllogic
  docs/zero-bug-plan.md
---

## What was built

97 unit tests in `test/runtime/temporal-arithmetic.spec.ts` and ~80 end-to-end SQL assertions in `test/logic/107-temporal-arithmetic-mutation-kills.sqllogic` targeting mutation kills in `temporal-arithmetic.ts` and the temporal dispatch paths in `binary.ts`.

## Coverage

### Unit tests (`temporal-arithmetic.spec.ts`)

Direct calls to `tryTemporalArithmetic` and `tryTemporalComparison`:

**tryTemporalArithmetic** — one describe per operand-type combination:
- NULL propagation (both operands, single operand)
- Non-temporal operands → `undefined`
- DATE + TIMESPAN (including month rollover, leap year Feb 29→28, negative/zero intervals)
- TIMESPAN + DATE (commutative)
- DATE - TIMESPAN (including negative timespan)
- DATE - DATE → TIMESPAN (positive, negative, zero)
- DATETIME + TIMESPAN (crossing midnight, month rollover, negative)
- TIMESPAN + DATETIME (commutative)
- DATETIME - TIMESPAN (across day boundary)
- DATETIME - DATETIME → TIMESPAN
- Mixed DATE/DATETIME subtraction
- TIME + TIMESPAN (wrap around midnight)
- TIMESPAN + TIME (commutative)
- TIME - TIMESPAN (wrap before midnight)
- TIME - TIME → TIMESPAN (positive, negative, zero)
- TIMESPAN + TIMESPAN, TIMESPAN - TIMESPAN
- TIMESPAN * NUMBER (integer, fractional, zero, calendar-unit)
- NUMBER * TIMESPAN (commutative, calendar-unit)
- TIMESPAN / NUMBER (integer, fractional, zero, calendar-unit)
- TIMESPAN / TIMESPAN → NUMBER ratio (equal, double, half, zero-divisor, calendar-unit → null)
- Unsupported operations throw (date+date, time+time, date*number, etc.)

**tryTemporalComparison**:
- Non-timespan operands → `undefined` (dates, numbers, null)
- All comparison operators: `=`, `==`, `!=`, `<>`, `<`, `<=`, `>`, `>=`
- Equivalent duration representations: `PT60M = PT1H`, `PT3600S = PT1H`
- Zero-length timespans
- Negative timespans
- Unsupported operator (`LIKE`) → `undefined`

### SQL logic tests (`107-temporal-arithmetic-mutation-kills.sqllogic`)

End-to-end queries covering all the same operator/type combinations plus:
- WHERE clause filtering with date arithmetic
- TIMESPAN column storage/retrieval
- TIMESPAN comparison in WHERE (equality, inequality, ordering)
- ORDER BY on TIMESPAN (lexicographic — documents known behavior)
- MIN/MAX aggregation on TIMESPAN

## Testing notes

- Non-calendar timespan multiplication/division normalizes to seconds (e.g., `PT1H * 2` → `PT7200S`)
- ORDER BY and MIN/MAX on TIMESPAN use lexicographic TEXT ordering, not semantic duration ordering — this is expected since sort uses the physical type, while WHERE comparisons go through `tryTemporalComparison`
- No timezone arithmetic: all timestamps are plain (no zone-aware math)
- `docs/types.md` temporal section is accurate; no divergence found

## Validation

```bash
cd packages/quereus
yarn test              # all pass (97 new unit + ~80 sqllogic assertions)
```
