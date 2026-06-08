---
description: Utilities subsystem review - comparison, coercion, affinity, errors, cross-platform
prereq: none

---

# Utilities Subsystem Review

## Summary

Adversarial review of utility modules covering comparison, coercion, affinity, error handling, serialization, and cross-platform concerns. Identified and fixed 8 issues, added 96 new tests (unit + SQL logic).

## Changes Made

### Bug Fixes

- **Removed `evaluateIsTrue` (unused, incorrect BLOB semantics)**: Had Uint8Array always returning false, contradicting SQLite where non-empty BLOBs are truthy. The `isTruthy` function (which was actually used in runtime) had correct semantics and remains the single truthiness function.

- **Removed duplicate `ParseError` from `errors.ts`**: Two `ParseError` classes existed; only the one in `parser.ts` was ever imported. Removed the unused one from `errors.ts` along with its orphaned `Token` import.

- **Fixed `QuereusError.cause` shadowing ES2022 `Error.cause`**: The explicit `public cause?: Error` property shadowed the native Error.cause. Now passes `cause` through the `super()` options bag, letting the native property handle it. `unwrapError` continues to work correctly.

- **Cross-platform `Buffer.from()` replacement**: `serialization.ts` and `ast-stringify.ts` both used Node-specific `Buffer.from().toString('hex')`. Replaced with a cross-platform `uint8ArrayToHex()` helper (extracted as shared export from `serialization.ts`).

### Code Quality Improvements

- **DRY: Plugin helper error patterns**: Extracted `errorMessage()` helper in `plugin-helper.ts` to eliminate 4x repeated `error instanceof Error ? error.message : String(error)` pattern. Changed thrown errors from plain `Error` to `QuereusError` with cause preservation.

- **Consistent `Object.setPrototypeOf`**: Added to `ConstraintError` constructor for consistency with `SyntaxError` and `MisuseError`, ensuring correct `instanceof` behavior.

- **Optimized `coerceForAggregate`**: Reduced from 3 `toUpperCase()` calls per invocation to 1 by caching the uppercased name and extracting `NON_NUMERIC_AGGREGATES` as a module-level `Set`.

- **Removed redundant `Math.trunc()`**: In `tryCoerceToNumber`, `Number.isInteger()` already guarantees the value is integral, making the subsequent `Math.trunc()` redundant.

- **Simplified `isNumericValue`**: Refactored to delegate to `tryCoerceToNumber` rather than duplicating its parsing logic.

- **Removed wasteful `isDebugEnabled`**: Created a new logger on every call just to check `.enabled`. Callers migrated to `isLoggingEnabled` from `logger.ts` which uses `debug.enabled()` directly.

## Known Risks (Documented, Not Fixed)

- **Global `collations` Map**: Registered collations are shared across all `Database` instances. Could cause issues in multi-tenant scenarios. Accepted for now since collation registration is rare and typically done at startup.

- **`resolveCollation` silent fallback**: Unknown collation names silently fall back to BINARY with a warning log. Could hide typos. Accepted as defensive behavior.

- **`sqlValuesEqual` treats `null === null` as true**: This is intentional for set-equality contexts (DISTINCT, set operations) where NULL-equals-NULL is needed. SQL three-valued logic for WHERE clauses is handled separately in the binary operator emitters.

- **Affinity functions possibly unused**: `applyIntegerAffinity`, `applyRealAffinity`, etc. in `affinity.ts` may be dead code. They appear designed for future schema-level affinity application. Left in place pending further investigation.

- **`tryParseReal` uses `parseFloat`**: More lenient than `Number()` (stops at first invalid char). This may be intentional for affinity conversion but should be verified against SQLite behavior.

## Test Coverage Added

### Unit Tests (`test/utility-edge-cases.spec.ts`) - 96 tests

- `compareSqlValues`: NULL ordering, storage class ordering, boolean-as-numeric, BigInt/number cross-type, blob byte-wise comparison, empty values
- `compareSqlValuesFast`: Direct collation function usage
- `isTruthy`: All SqlValue types including Uint8Array edge cases
- `tryCoerceToNumber`: Whitespace, scientific notation, hex, Infinity/NaN, pass-through
- `coerceToNumberForArithmetic`: All type conversions
- `coerceForComparison`: Cross-type coercion, null handling, no-coercion cases
- `coerceForAggregate`: Function-specific rules (COUNT, SUM, MIN, JSON functions)
- `isNumericValue`: All type detection cases
- `uint8ArrayToHex`: Empty, single byte, multi-byte
- Error utilities: QuereusError cause chains, unwrapError, instanceof checks
- Collation edge cases: NOCASE unicode, RTRIM trailing spaces
- `getSqlDataTypeName`: All SQL type mappings
- `compareRows`, `sqlValuesEqual`: Row-level and value-level equality
- `compareWithOrderBy`: Direction, NULLS FIRST/LAST, default ordering
- `compareTypedValues`, `createTypedComparator`: Type-aware comparison

### SQL Logic Tests (`test/logic/14-utilities.sqllogic`) - ~53 test cases

- NULL comparison semantics (three-valued logic)
- NULL sorting with NULLS FIRST/LAST
- Storage class ordering (NULL < NUMERIC < TEXT < BLOB)
- Collation tests (BINARY, NOCASE, RTRIM)
- Coercion edge cases (numeric strings, scientific notation, arithmetic)
- Truthiness in WHERE and CASE
- Aggregate coercion (SUM with numeric strings, MIN/MAX with mixed types)

## Files Modified

- `packages/quereus/src/common/errors.ts` - Removed duplicate ParseError, fixed cause shadowing, added setPrototypeOf
- `packages/quereus/src/util/comparison.ts` - Removed unused evaluateIsTrue
- `packages/quereus/src/util/coercion.ts` - Optimized coerceForAggregate, simplified isNumericValue, removed redundant Math.trunc
- `packages/quereus/src/util/serialization.ts` - Cross-platform hex encoding, exported uint8ArrayToHex
- `packages/quereus/src/util/plugin-helper.ts` - DRY error patterns, QuereusError usage
- `packages/quereus/src/util/environment.ts` - Removed isDebugEnabled
- `packages/quereus/src/emit/ast-stringify.ts` - Cross-platform hex encoding
- `packages/quereus/src/runtime/emit/cache.ts` - Migrated to isLoggingEnabled
- `packages/quereus/src/planner/framework/trace.ts` - Migrated to isLoggingEnabled
- `packages/quereus/src/index.ts` - Removed evaluateIsTrue export
- `packages/quereus/test/exports.spec.ts` - Removed evaluateIsTrue test
- `docs/plugins.md` - Removed evaluateIsTrue reference

## Files Added

- `packages/quereus/test/utility-edge-cases.spec.ts` - 96 unit tests
- `packages/quereus/test/logic/14-utilities.sqllogic` - ~53 SQL logic tests

## Validation

- All 407 tests pass (up from 311)
- TypeScript compilation clean (2 pre-existing unrelated errors in join.ts/window.ts)
- No lint errors introduced
