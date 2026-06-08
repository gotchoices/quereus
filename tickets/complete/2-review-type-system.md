description: Review of type system (logical types, temporal types, registry, validation)
files:
  packages/quereus/src/types/builtin-types.ts
  packages/quereus/src/types/index.ts
  packages/quereus/src/types/json-type.ts
  packages/quereus/src/types/logical-type.ts
  packages/quereus/src/types/plugin-interface.ts
  packages/quereus/src/types/registry.ts
  packages/quereus/src/types/temporal-types.ts
  packages/quereus/src/types/validation.ts
  packages/quereus/test/type-system.spec.ts
----
## Findings

### defect: INTEGER_TYPE.compare loses precision for large bigints
file: packages/quereus/src/types/builtin-types.ts:57
The compare function converted bigint values to Number before comparison via `Number(a)`, which loses precision for values outside the safe integer range (>2^53). Two distinct bigints could compare as equal.
Ticket: fixed in review — changed to use direct `<`/`>` operators which JS supports natively across number and bigint.

### defect: JSON_TYPE test asserted wrong validate semantics
file: packages/quereus/test/type-system.spec.ts:335
The test expected `validate('not json')` to return `false`, but `validate` checks native JS values (where strings are valid JSON scalars). JSON syntax checking is the responsibility of `parse`. The test was hidden by `--bail` stopping at an earlier unrelated failure.
Ticket: fixed in review — corrected test expectations, expanded JSON_TYPE tests to cover validate/parse distinction including objects, arrays, blobs, and parse error cases.

### smell: TIMESPAN_TYPE.compare uses localeCompare in fallback
file: packages/quereus/src/types/temporal-types.ts:266
The fallback string comparison used `localeCompare` which is locale-dependent and inconsistent with `BINARY_COLLATION` used by all other types.
Ticket: fixed in review — changed to `BINARY_COLLATION`.

### smell: TIME_TYPE.parse truncates fractional seconds from numeric input
file: packages/quereus/src/types/temporal-types.ts:83
Numeric input like `3661.5` (seconds since midnight) has fractional seconds silently truncated by the `PlainTime` constructor. Also, negative numeric input throws `RangeError`.
Ticket: tickets/fix/time-type-numeric-fractional-seconds.md

### note: TIMESPAN comparison uses hardcoded reference date
file: packages/quereus/src/types/temporal-types.ts:259
Duration comparison resolves calendar units (months/years) using a fixed reference date of 2024-01-01. "1 month" always resolves to 31 days (January). This is documented and reasonable — a necessary trade-off for total ordering of durations.

### note: JSON_TYPE compare has null ambiguity for JSON "null" strings
file: packages/quereus/src/types/json-type.ts:63
After `safeJsonParse`, `null` can mean either JSON null literal or parse failure. Edge case since JSON columns store native values, not JSON strings.

## Trivial Fixes Applied
- builtin-types.ts:57 — INTEGER_TYPE.compare: replaced `Number(bigint)` conversion with direct `<`/`>` comparison to preserve bigint precision
- temporal-types.ts:266 — TIMESPAN_TYPE.compare: replaced `localeCompare` with `BINARY_COLLATION` in fallback path
- json-type.ts:14-20 — verified validate semantics are correct (strings are JSON scalars); no code change needed
- type-system.spec.ts:333-338 — fixed JSON_TYPE test: corrected validate expectations, added parse error test, expanded coverage

## No Issues Found
- logical-type.ts — clean
- index.ts — clean (barrel exports)
- registry.ts — clean
- validation.ts — clean
- plugin-interface.ts — clean
