---
description: Completed review of testing strategy and test coverage across the Quereus project
prereq: none

---

# Testing Strategy Review — Completed

This document summarizes the review of the Quereus testing strategy, including coverage assessment, new tests written, and code quality inspection.

## 1. Current State

- **353 tests passing**, 1 known failing (self-join performance sentinel: 26s vs 8s threshold — pre-existing, pending bloom/hash join implementation per `tasks/plan/4-join-algorithms.md`)
- **Total runtime**: ~30s
- **No flaky tests** detected
- **Zero skipped or broken tests** (5 skipped in event hooks are explicitly marked for unimplemented features)

## 2. Coverage Assessment

### Strong Coverage

| Area | Test Files | Notes |
|------|-----------|-------|
| Parser | `parser.spec.ts`, 55+ `.sqllogic` files | Comprehensive via SQLLogic |
| Optimizer | 11 files in `optimizer/` | Individual rule tests + golden plans |
| VTab/Memory | `memory-vtable.spec.ts` (36 tests) | CRUD, cursors, constraints |
| Core API | `core-api-features.spec.ts`, `core-api-transactions.spec.ts`, `lifecycle.spec.ts` | Features, transactions, lifecycle |
| Integration | `integration-boundaries.spec.ts` | All boundary pairs tested |
| Utilities | `utility-edge-cases.spec.ts` | Comparison, coercion, serialization, errors |
| Property-Based | `property.spec.ts` | Collation, numeric affinity, JSON roundtrip |
| SQLLogic | 55+ `.sqllogic` files | All SQL features: CRUD, joins, window functions, aggregates, subqueries, CTEs, constraints, transactions, set operations, views |
| Performance | `performance-sentinels.spec.ts` | Parser throughput, query execution, self-join |
| Golden Plans | `plan/golden-plans.spec.ts` | Snapshot testing for query plans |

### Gaps Identified and Addressed

| Gap | Action Taken |
|-----|-------------|
| No type system unit tests | Created `type-system.spec.ts` (51 tests) |
| No schema manager unit tests | Created `schema-manager.spec.ts` (15 tests) |
| No dedicated runtime/emitter unit tests | Documented as future work (covered indirectly by SQLLogic + integration tests) |

## 3. New Tests Written

### `test/type-system.spec.ts` — 51 tests
- **Type Registry** (8): lookup, case-insensitivity, unknown types, defaults, SQL aliases, hasType
- **Type Inference / SQLite Affinity** (8): INT→INTEGER, CHAR/CLOB/TEXT→TEXT, REAL/FLOA/DOUB→REAL, BOOL→BOOLEAN, NUMERIC/DECIMAL→NUMERIC, default→BLOB, exact match priority
- **getPhysicalType** (1): runtime value classification
- **Built-in Type Behaviours** (26): NULL, INTEGER (validate, parse, truncate, error, compare, isNumeric), REAL (validate, parse, NaN), TEXT (validate, parse, isTextual, collations), BLOB (validate, parse hex), BOOLEAN (validate, parse, error), NUMERIC (prefer integer), ANY (accept all, passthrough), DATE (validate, normalise, isTemporal), JSON (validate)
- **Validation Utilities** (7): validateValue, parseValue, validateAndParse, isValidForType, tryParse
- **Custom Type Registration** (1): register and retrieve

### `test/schema-manager.spec.ts` — 15 tests
- **Default schemas** (2): main/temp existence, non-existent schema error
- **addSchema** (3): create, case-insensitivity, duplicate prevention
- **setCurrentSchema** (2): change current, handle non-existent
- **Table operations via SQL** (3): create/find, case-insensitive lookup, missing table
- **View operations via SQL** (2): create/lookup, view shadows table
- **clearAll** (1): remove all tables
- **getSchemaItem with explicit schema** (2): find in specified schema, wrong schema

## 4. Code Quality Inspection

### Good Practices Found
- Consistent `should...` naming convention across all test files
- Proper AAA (Arrange-Act-Assert) pattern
- Proper cleanup with `afterEach(() => db.close())`
- No missing assertions
- Well-structured `describe` blocks

### Issues Found (Non-blocking)

| Issue | Severity | Details |
|-------|----------|---------|
| `collect()` helper duplicated | Medium | Defined in `performance-sentinels.spec.ts`, reimplemented inline elsewhere |
| Inconsistent error testing | Low | Mix of try-catch and `expect().to.throw` patterns |
| Magic numbers in perf thresholds | Low | Threshold values hardcoded without named constants |
| Shared mutable state | Medium | `property.spec.ts` and `memory-vtable.spec.ts` share db/module across tests |
| Inconsistent table naming | Low | Mix of `_t` suffix, descriptive names, no standard prefix |

## 5. Remaining Recommendations

1. **Extract shared test helpers**: Move `collect()` to a shared `test/helpers/` module
2. **Standardize error testing**: Prefer `expect().to.throw` for sync, try-catch for async
3. **Add coverage measurement**: Integrate c8 or nyc for coverage tracking
4. **Runtime/emitter unit tests**: Add dedicated tests for the emitter layer (currently only covered indirectly)
5. **Extract performance threshold constants**: Move magic numbers to named constants

## 6. Documentation Updates

- Updated `packages/quereus/README.md` testing section:
  - Changed "Performance Sentinels (Planned)" → documented as implemented with details
  - Added "Unit Tests" section describing type system, schema manager, optimizer, integration boundary, and golden plan tests
  - Updated summary paragraph to reflect all test categories

## 7. Files Created

- `packages/quereus/test/type-system.spec.ts` (51 tests)
- `packages/quereus/test/schema-manager.spec.ts` (15 tests)

## 8. Files Modified

- `packages/quereus/README.md` (updated testing section)

## 9. Files Reviewed

- `packages/quereus/test/core-api-features.spec.ts`
- `packages/quereus/test/core-api-transactions.spec.ts`
- `packages/quereus/test/lifecycle.spec.ts`
- `packages/quereus/test/integration-boundaries.spec.ts`
- `packages/quereus/test/performance-sentinels.spec.ts`
- `packages/quereus/test/property.spec.ts`
- `packages/quereus/test/memory-vtable.spec.ts`
- `packages/quereus/test/utility-edge-cases.spec.ts`
- `packages/quereus/test/logic.spec.ts`
- `packages/quereus/test/parser.spec.ts`
- `packages/quereus/test/optimizer/*.spec.ts` (11 files)
- `packages/quereus/test/plan/golden-plans.spec.ts`

