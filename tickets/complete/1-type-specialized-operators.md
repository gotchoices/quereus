---
description: Emit-time type specialization for binary operators and aggregate coercion
---

## Summary

Used plan-time type information available at emission to select specialized runtime `run` functions, eliminating unnecessary type checks and coercion on hot paths.

### Changes

**Arithmetic Specialization** (`packages/quereus/src/runtime/emit/binary.ts`)
- `emitNumericOp()` reads `plan.left.getType().logicalType` at emit time to select one of three paths:
  - **Temporal**: when either operand has `isTemporal` — routes through `tryTemporalArithmetic()` first
  - **Numeric-fast**: when both operands are `isNumeric` — skips temporal check and `coerceToNumberForArithmetic()` entirely
  - **Generic**: for TEXT or mixed types — preserves full temporal check + coercion

**Comparison Specialization** (`packages/quereus/src/runtime/emit/binary.ts`)
- `emitComparisonOp()` refactored with shared `buildCmpToResult()` helper (eliminates per-operator duplication)
- Two paths:
  - **Same-category fast**: both numeric or both textual, neither temporal — goes directly to `compareSqlValuesFast()`
  - **Generic**: temporal check + `coerceForComparison()` for mixed-type or temporal operands

**Aggregate Coercion Skip** (`packages/quereus/src/runtime/emit/aggregate.ts`)
- Pre-computes `aggregateSkipCoercion[]` at emit time — skips `coerceForAggregate()` when all arguments to a numeric aggregate already have numeric plan-time types

**Conversion Function Return Types** (`packages/quereus/src/func/builtins/conversion.ts`)
- All conversion functions (`integer()`, `real()`, `text()`, `boolean()`, `date()`, `time()`, `datetime()`, `timespan()`, `json()`) declare explicit `returnType` matching their output type — previously defaulted to `REAL_TYPE`, breaking plan-time type inference (e.g., `date() - date()` temporal arithmetic)

### Testing

- 665 tests pass (7 pending/skipped)
- Temporal arithmetic (`date() - date()` → TIMESPAN) verified working after return type fix
- Conversion functions, comparison operators, and aggregate coercion all covered by existing sqllogic and spec tests
