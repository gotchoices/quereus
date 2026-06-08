description: Fixed TIME_TYPE.parse to preserve fractional seconds, reject negative input, and correctly carry millisecond overflow
prereq: none
files:
  packages/quereus/src/types/temporal-types.ts
  packages/quereus/test/type-system.spec.ts
----
## What was built

`TIME_TYPE.parse` numeric input handling was fixed for:

1. **Fractional seconds preservation**: Numeric seconds-since-midnight values like `3661.5` now correctly produce `01:01:01.5`.
2. **Negative input rejection**: Negative values throw a descriptive `TypeError` instead of crashing with a `RangeError`.
3. **Millisecond carry bug** (found during review): When fractional seconds round to 1000ms (e.g., `59.9999`), the original code silently dropped them via `% 1000`. Fixed by converting to total milliseconds with integer arithmetic, eliminating carry issues entirely.

## Key files

- `packages/quereus/src/types/temporal-types.ts` — TIME_TYPE.parse numeric branch uses `Math.round(v * 1000)` then integer division for hours/minutes/seconds/milliseconds
- `packages/quereus/test/type-system.spec.ts` — 9 TIME_TYPE tests covering ISO validation, numeric seconds, fractional preservation, carry edge cases, negative rejection, string parsing, null handling, and isTemporal flag

## Testing notes

- All 9 TIME_TYPE tests pass
- Full suite: 329 passing, 1 pre-existing failure (DDL lifecycle test, unrelated)
- Key edge cases verified: `59.9999` → `00:01:00`, `3599.9999` → `01:00:00`
