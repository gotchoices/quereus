description: `mixedBigIntArithmetic` now coerces the non-bigint operand through `coerceToNumberForArithmetic`, so `bigint + text` (and other mixed-type arithmetic from ANY columns) returns a numeric result instead of silently producing null.
files:
  packages/quereus/src/runtime/emit/binary.ts (mixedBigIntArithmetic, lines 48-88)
  packages/quereus/src/util/coercion.ts (coerceToNumberForArithmetic — used as-is)
  packages/quereus/test/logic/03.7-bigint-mixed-arithmetic.sqllogic (15 vectors total: 10 original + 5 mixed-type)
  packages/quereus/test/logic/10-distinct_datatypes.sqllogic (lines 90-94 — original failing case `5 + '3' = 8`)
----

## What was built

`mixedBigIntArithmetic` in `packages/quereus/src/runtime/emit/binary.ts` previously cast the non-bigint operand with a TypeScript `as number` assertion (a compile-time no-op). When the runtime value was a string from an `ANY` column, the float fallback executed `bigintAsNumber + 'text'`, JavaScript performed string concatenation, and `Number.isFinite` then rejected the result — silently returning `null`.

The non-bigint side is now normalized via `coerceToNumberForArithmetic` (the same affinity rule used by the non-bigint arithmetic paths) before the integer-promotion / float-fallback split. The integer-promotion path uses `BigInt(coercedValue)` instead of `BigInt(rawValue as number)`, and the float fallback uses the coerced number directly.

Behavior preserved:
- bigint + bigint → bigint arithmetic (unchanged).
- bigint + integer-valued number (incl. integer-valued numeric string like `'3'` or `'2.0'`) → BigInt promotion.
- bigint + fractional number (incl. fractional numeric string like `'0.5'`) → float fallback.
- bigint + non-numeric string / blob / null → coerces to 0 (matches the non-bigint path).

All three call sites of the helper (`runTemporalArithmetic`, `runNumericOnly`, `runGenericArithmetic` in the same file) guard with `v1 !== null && v2 !== null` and `typeof v1 === 'bigint' || typeof v2 === 'bigint'`, so the helper preconditions hold.

## Verification

```
yarn workspace @quereus/quereus test --grep "bigint"            → 9 passing
yarn workspace @quereus/quereus test --grep "distinct_datatypes" → 1 passing
yarn workspace @quereus/quereus test                            → 993 passing, 1 pre-existing failure
                                                                  (`Predicate normalizer / double negation`, unrelated)
yarn workspace @quereus/quereus lint                            → clean
```

`03.7-bigint-mixed-arithmetic.sqllogic` covers the new vectors:

```sql
SELECT 9007199254740993 + '3';     -- 9007199254740996 (integer string → BigInt promotion)
SELECT '3' + 9007199254740993;     -- 9007199254740996 (reversed order)
SELECT 9007199254740993 + 'abc';   -- 9007199254740993 (non-numeric string → 0)
SELECT 9007199254740993 + true;    -- 9007199254740994 (boolean → 1, BigInt-promoted)
SELECT 9007199254740993 + '0.5';   -- 9007199254740992 (fractional string → float fallback,
                                   --                   IEEE 754 banker's rounding at 2^53)
```

The original failing case in `10-distinct_datatypes.sqllogic:90-94` (`coerce_test` row 1: `5 + '3' = 8`, ANY columns) now passes once the storage layer hands integer values to the bigint path.

## Review notes

- **Coerce-once safety:** `v1n` / `v2n` capture coerced values; both inputs are already-resolved `SqlValue`s, so no double-evaluation of side-effecting input.
- **Branch selector safety:** `const num = typeof v1n === 'bigint' ? v2n : v1n` picks the non-bigint side. Since at least one input is `bigint`, at least one of `v1n` / `v2n` is `bigint`. If a future call site fed two non-bigints, the integer-promotion branch would still be safe — `BigInt(0.5)` throws and the catch falls through to the float path — though the helper's name and current call sites make that scenario non-current.
- **Null safety:** `coerceToNumberForArithmetic(null) === 0`, but all three call sites null-guard upstream, so it's not currently reachable.

## Downstream

`lamina/packages/lamina-quereus-test/src/sqllogic/known-failures.ts` lists `10-distinct_datatypes.sqllogic` under `lamina-quereus-string-to-blob-affinity-coercion`. With this fix landed, the lamina-side entry can be retired.
