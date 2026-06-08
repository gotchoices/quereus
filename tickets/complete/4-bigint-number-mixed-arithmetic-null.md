description: Fix mixed bigint/number arithmetic returning null — coerce operands when types differ
files:
  packages/quereus/src/runtime/emit/binary.ts
  packages/quereus/test/logic.spec.ts
  packages/quereus/test/logic/03.7-bigint-mixed-arithmetic.sqllogic
----

## What was built

Extracted a `mixedBigIntArithmetic` helper in `binary.ts` that replaces three
identical (and broken) bigint branches in `runTemporalArithmetic`, `runNumericOnly`,
and `runGenericArithmetic`. The old code cast mixed operands as `bigint` via
TypeScript assertions, causing JavaScript `TypeError` at runtime which was silently
swallowed → `null`.

Coercion strategy:
1. Both bigint → bigint arithmetic directly
2. Mixed, number is integer (`Number.isInteger`) → promote number to BigInt
3. Mixed, number is fractional → demote bigint to Number, use float arithmetic

Also added `normalizeBigInts` in `logic.spec.ts` to bridge BigInt↔Number comparison
since JSON.parse cannot represent BigInt values.

## Testing

`03.7-bigint-mixed-arithmetic.sqllogic` — 10 cases covering all 5 operators
(`+`, `-`, `*`, `/`, `%`), both operand orders, pure bigint+bigint regression,
`typeof` verification, integer promotion, and float coercion paths.

All 1013 tests pass. No lint regressions in changed files.

## Usage

Mixed bigint/number arithmetic now works transparently:
```sql
SELECT 9007199254740993 + 1.5;   -- float path (precision loss expected)
SELECT 9007199254740993 + 1;     -- integer promotion (exact bigint result)
SELECT 9007199254740993 % 2.0;   -- 2.0 is integer → BigInt, result = 1 (exact)
```
