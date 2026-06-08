---
description: Review of sample plugins - completed implementation
prereq: none
---

# Sample Plugins Review - Summary

Reviewed and fixed all four sample plugins in `packages/sample-plugins/`. Every plugin was rewritten to use the correct Quereus plugin API and now has passing tests.

## Plugins Reviewed

1. **string-functions** — 7 custom SQL functions (6 scalar, 1 table-valued)
2. **custom-collations** — 5 collation functions (NUMERIC, LENGTH, REVERSE, ALPHANUM, PHONETIC)
3. **comprehensive-demo** — Demonstrates all plugin types: vtable (key_value_store), functions (math_round_to, hex_to_int, int_to_hex, data_summary), collation (UNICODE_CI)
4. **json-table** — Read-only virtual table for JSON data from URLs, files, or inline strings

## Issues Found and Fixed

### API Correctness (all plugins)
- **Incorrect `returnType` format**: All function schemas used `{ typeClass: 'scalar', sqlType: 'TEXT' }` which doesn't match the actual `ScalarType` interface requiring `logicalType`, `nullable`, `isReadOnly`. Replaced with proper `ScalarType`/`RelationType` structures using `TEXT_TYPE`, `INTEGER_TYPE`, `REAL_TYPE` from the main package.
- **Magic number flags**: All plugins used `flags: 1` instead of `FunctionFlags.UTF8`. Added `FunctionFlags.DETERMINISTIC` to all pure functions.
- **Manual schema construction**: Replaced verbose manual `{ schema: { ... } }` objects with `createScalarFunction()` and `createTableValuedFunction()` helpers.
- **TVF return type**: `strStats` and `dataSummary` returned `Generator<Record<string, SqlValue>>` instead of `AsyncIterable<Row>`.

### Virtual Table Implementations (comprehensive-demo, json-table)
- **Not extending VirtualTable**: Both plugins constructed ad-hoc objects instead of extending the `VirtualTable` abstract class. Rewrote to properly subclass it.
- **No shared state between create/connect**: The `connect()` method (called at query time) created fresh instances with empty state, losing all data. Added module-level registries for state sharing.
- **Iterator mutation bug** (comprehensive-demo): `query()` iterated directly over the `Map` store, which could hang when concurrent `update()` calls modified the map during iteration. Fixed by snapshotting entries before iteration.
- **Missing vtabArgs propagation** (json-table): `connect()` didn't receive tableSchema from the scan emitter, so inline JSON data was inaccessible at query time. Fixed by caching tableSchema at `create()` time and using `options` parameter at `connect()` time.

### Code Quality
- **Removed `console.log`**: All plugins had unconditional `console.log` debug output.
- **DRY violation**: `numericCollation` and `alphanumCollation` had duplicate tokenization logic. Extracted shared `tokenize()` and `compareTokens()` functions.
- **Unused import**: `FunctionFlags` was imported as a type in string-functions but never used.
- **Missing `manifest` exports**: Added proper manifest metadata exports to all TypeScript source files.
- **Added `PluginRegistrations` return type** to all `register()` functions.
- **Removed stale compiled `.js` files**: All four `index.js` files were outdated and removed.

### Documentation
- Updated all READMEs with correct `registerPlugin()` installation instructions.
- Removed references to `dynamicLoadModule` and URL-based loading.
- Fixed source code references from `index.js` to `index.ts`.

### Infrastructure
- Added test infrastructure (`register.mjs`, `tsconfig.test.json`).
- Updated `package.json` test script and `files` field.

## Test Coverage

34 tests across all four plugins, all passing:

- **String Functions**: 14 tests covering all 7 functions with null handling
- **Custom Collations**: 4 tests covering NUMERIC, LENGTH, REVERSE, ALPHANUM collations
- **Comprehensive Demo**: 11 tests covering KV store CRUD, all functions, and UNICODE_CI collation
- **JSON Table**: 5 tests covering inline JSON, multi-column, empty data, invalid JSON, and read-only enforcement

## Validation

- TypeScript compilation: clean (`tsc --noEmit`)
- All 34 sample-plugin tests: passing
- Main quereus test suite: 49 passing, 0 failing (no regressions)

## Systemic Observations

During this review, one broader issue became apparent:

- **`connect()` doesn't receive `tableSchema`**: The scan emitter only passes 6 arguments to `module.connect()`, omitting the optional 7th `tableSchema` parameter. This forces modules to cache their own schema from `create()` time. This is a minor architectural gap - the scan emitter already has the schema available and could pass it through. Not blocking for sample plugins, but worth noting for the vtab interface review.

## TODO

- [ ] Verify tests pass
- [ ] Inspect code for adherence to plugin API patterns
- [ ] Check that README documentation is accurate
