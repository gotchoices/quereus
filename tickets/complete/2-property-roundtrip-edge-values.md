description: Property-based tests for insert/select roundtrip with boundary and edge values
files:
  packages/quereus/test/property.spec.ts
----
## Summary

Added 7 deterministic boundary-value test cases to `property.spec.ts` covering integer boundaries,
bigint boundaries, special strings, empty blobs, NULL-heavy rows, temporal boundaries, and JSON
edge values. All tests pass (1722 passing, 0 failures).

## Review notes

- **Bug fixed during review**: The JSON edge values test had a comma operator instead of semicolon
  on line 318, causing the descriptive error message to be a dead expression. Fixed to use Chai's
  `expect(value, message).to.be.true` pattern.
- Resource cleanup verified: all statements finalized in `finally`, DB closed in `afterEach`.
- BigInt test correctly handles safe-range demotion (bigints within `Number.MAX_SAFE_INTEGER` may
  return as `number`).
- Temporal boundary tests document actual `datetime()` behavior (ISO 8601 T separator output).

## Key test cases

- **Integer boundaries**: MAX/MIN_SAFE_INTEGER, INT32 bounds, UINT32_MAX
- **BigInt boundaries**: INT64_MAX/MIN, safe-range bigint demotion
- **Special strings**: empty, NUL, 10K chars, numeric-looking, emoji, ZWJ, SQL injection
- **Empty blob**: zero-length Uint8Array roundtrip
- **NULL-heavy rows**: all-NULL single and 10-row batch
- **Temporal boundaries**: extreme dates, leap year, midnight/last-second, fractional normalization
- **JSON edge values**: 12-level nesting, 1000-element array, empty-key, mixed types, empty containers
