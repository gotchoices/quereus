---
description: Completed review of type system (logical types, physical types, coercion, comparison)
prereq: none

---

# Type System Review — Completed

This document summarizes the review and fixes applied to the Quereus type system, covering logical types, physical types, coercion, comparisons, and CAST handling.

## 1. Architecture Summary

The type system is well-structured with clean layering:

- **LogicalType** (`types/logical-type.ts`) — Interface defining type semantics: validate, parse, compare, serialize
- **PhysicalType** (`types/logical-type.ts`) — Enum for storage representations (NULL, INTEGER, REAL, TEXT, BLOB, BOOLEAN)
- **Built-in Types** (`types/builtin-types.ts`) — NULL, INTEGER, REAL, TEXT, BLOB, BOOLEAN, NUMERIC, ANY
- **Temporal Types** (`types/temporal-types.ts`) — DATE, TIME, DATETIME, TIMESPAN using Temporal API
- **JSON Type** (`types/json-type.ts`) — JSON with deep equality comparison
- **Type Registry** (`types/registry.ts`) — Global registry with alias support and SQLite affinity inference
- **Validation** (`types/validation.ts`) — validateValue, parseValue, validateAndParse utilities
- **Plugin Interface** (`types/plugin-interface.ts`) — TypePluginInfo for custom type registration

### Integration Points
- **Coercion** (`util/coercion.ts`) — Arithmetic and comparison coercion
- **Comparison** (`util/comparison.ts`) — Storage-class comparison, collation support, ORDER BY
- **Affinity** (`util/affinity.ts`) — SQLite affinity application functions
- **Cast** (`runtime/emit/cast.ts`) — Runtime CAST expression evaluation
- **Planner** (`planner/type-utils.ts`, `planner/nodes/scalar.ts`) — Type inference and propagation

### Strengths
- Clean logical/physical type separation
- Extensible via registry with plugin support
- Good SQLite affinity compatibility
- Comprehensive temporal type support via Temporal API
- Deep JSON equality comparison

## 2. Issues Found & Fixed

### 2.1 DRY: Null-Comparison Boilerplate (Fixed)
**12 occurrences** of the identical pattern across type compare functions:
```typescript
if (a === null && b === null) return 0;
if (a === null) return -1;
if (b === null) return 1;
```

**Fix:** Extracted `compareNulls()` helper into `logical-type.ts`:
```typescript
export function compareNulls(a: SqlValue, b: SqlValue): number | undefined {
    if (a === null) return b === null ? 0 : -1;
    if (b === null) return 1;
    return undefined;
}
```
Used across all compare functions in `builtin-types.ts`, `temporal-types.ts`, and `json-type.ts`. Simple cases collapse to one-liners: `compare: (a, b) => compareNulls(a, b) ?? 0`.

### 2.2 DRY: ANY_TYPE Duplicated getStorageClass (Fixed)
**File:** `builtin-types.ts`, `ANY_TYPE.compare`

`ANY_TYPE.compare` contained an inline `getStorageClass` function duplicating logic from `util/comparison.ts`.

**Fix:** Replaced with `compareSqlValuesFast(a, b, BINARY_COLLATION)` which already implements the same SQLite comparison rules correctly.

### 2.3 DRY: CAST Emitter Duplicated Parse Logic (Fixed)
**File:** `runtime/emit/cast.ts` (~150 lines → ~50 lines)

Five separate `castToInteger()`, `castToReal()`, `castToText()`, `castToBlob()`, `castToNumeric()` functions duplicated the conversion logic already present in `LogicalType.parse()` methods.

**Fix:** Refactored to use the type registry's `inferType()` + `logicalType.parse()`, with a `castFallback()` for SQL's lenient CAST behavior (non-numeric strings become 0, etc.).

### 2.4 Bug: BLOB_TYPE.compare Returned Unbounded Values (Fixed)
**File:** `builtin-types.ts`, `BLOB_TYPE.compare`

```typescript
// Before: could return any integer
return blobA.length - blobB.length;
// After: normalized to -1/0/1
return blobA.length < blobB.length ? -1 : blobA.length > blobB.length ? 1 : 0;
```

### 2.5 Bug: Temporal Types Used localeCompare (Fixed)
**Files:** `temporal-types.ts` — DATE_TYPE, TIME_TYPE, DATETIME_TYPE

`localeCompare` is locale-dependent and can produce inconsistent results across environments. ISO 8601 strings are already designed for lexicographic comparison.

**Fix:** Replaced with `BINARY_COLLATION` (standard `<`/`>` comparison), which is correct for ISO 8601 formatted strings.

### 2.6 Bug: BOOLEAN_TYPE.parse Bigint Comparison (Fixed)
**File:** `builtin-types.ts`, `BOOLEAN_TYPE.parse`

```typescript
// Before: v !== 0 with bigint uses strict equality — 0n !== 0 is true (wrong!)
if (typeof v === 'number' || typeof v === 'bigint') { return v !== 0; }
// After: separate branches with correct comparisons
if (typeof v === 'number') return v !== 0;
if (typeof v === 'bigint') return v !== 0n;
```

### 2.7 `any` Type Removal (Fixed)
**File:** `builtin-types.ts` — `ANY_TYPE.compare` inline `getStorageClass(v: any)` eliminated (replaced with `compareSqlValuesFast`)

**File:** `json-type.ts` — `deepCompareJson(a: any, b: any)` retyped to `deepCompareJson(a: JSONValue, b: JSONValue)` using the project's `JSONValue` type. Also extracted `jsonTypeOrder()` helper.

## 3. Remaining Recommendations (Future Work)

### DRY: Type-Checking Chains
Multiple files duplicate `typeof value === 'number'` / `typeof value === 'string'` / `value instanceof Uint8Array` chains. `getPhysicalType()` exists in `logical-type.ts` but is not widely used. Candidates for consolidation:
- `util/comparison.ts` — `getStorageClass()` and `getSqlDataTypeName()`
- `util/coercion.ts` — `coerceForComparison()` inline checks
- `common/type-inference.ts` — `getLiteralSqlType()` duplicates `getPhysicalType()`

### Test Coverage
- No dedicated unit tests for `builtin-types.ts` parse/validate/compare functions
- No unit tests for temporal type parsing edge cases
- No unit tests for JSON deep comparison
- Property-based tests cover comparisons but not type conversion edge cases

### Type-Specific Concerns
- `INTEGER_TYPE.parse` uses `parseInt(trimmed, 10)` which silently truncates "123abc" → 123. Consider stricter parsing.
- `NUMERIC_TYPE.parse` uses separate int/real regex that doesn't handle scientific notation like "1e5"
- `BLOB_TYPE.parse` hex detection heuristic (`v.length % 2 === 0 && /^[0-9a-fA-F]*$/.test(v)`) could misidentify short strings like "ab" as hex

## 4. Code Quality Summary

| Aspect | Rating | Notes |
|--------|--------|-------|
| Architecture | Good | Clean logical/physical separation with registry |
| DRY | Improved | Null-comparison, CAST, ANY_TYPE deduplicated |
| Type Safety | Improved | `any` types eliminated |
| Bug Fixes | 3 fixed | BLOB compare, temporal localeCompare, boolean bigint |
| Test Coverage | Gaps | Type-specific unit tests recommended |

## 5. Files Modified

- `packages/quereus/src/types/logical-type.ts` (added `compareNulls`)
- `packages/quereus/src/types/builtin-types.ts` (DRY, bug fixes, `any` removal)
- `packages/quereus/src/types/temporal-types.ts` (DRY, localeCompare fix)
- `packages/quereus/src/types/json-type.ts` (DRY, `any` removal, refactored `deepCompareJson`)
- `packages/quereus/src/types/index.ts` (export `compareNulls`)
- `packages/quereus/src/runtime/emit/cast.ts` (refactored to use type registry)

## 6. Files Reviewed

- `packages/quereus/src/types/logical-type.ts`
- `packages/quereus/src/types/builtin-types.ts`
- `packages/quereus/src/types/temporal-types.ts`
- `packages/quereus/src/types/json-type.ts`
- `packages/quereus/src/types/registry.ts`
- `packages/quereus/src/types/validation.ts`
- `packages/quereus/src/types/plugin-interface.ts`
- `packages/quereus/src/types/index.ts`
- `packages/quereus/src/util/coercion.ts`
- `packages/quereus/src/util/comparison.ts`
- `packages/quereus/src/util/affinity.ts`
- `packages/quereus/src/common/types.ts`
- `packages/quereus/src/common/type-inference.ts`
- `packages/quereus/src/runtime/emit/cast.ts`
- `packages/quereus/src/planner/type-utils.ts`
