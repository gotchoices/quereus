---
description: Comprehensive review plan for schema management subsystem
prereq: none

---

# Schema Management Subsystem Review Plan

This document provides a comprehensive review plan for the schema management subsystem in the Quereus SQL query processor.

## Overview

The schema subsystem (`packages/quereus/src/schema/`) manages database metadata including tables, columns, indexes, views, functions, constraints, and triggers. This review will cover:

1. **Architecture Assessment**: Evaluate the overall design and integration points
2. **Code Quality Analysis**: Identify DRY violations, large functions, and maintainability issues  
3. **Test Coverage Gaps**: Identify missing unit and integration tests
4. **Documentation Review**: Assess API docs, code comments, and usage guides
5. **Defect Analysis**: Identify potential bugs, edge cases, and error handling issues

## Architecture Assessment

### Key Components (by file)

| File | Lines | Purpose | Critical |
|------|-------|---------|----------|
| `manager.ts` | ~1100 | SchemaManager: table/index creation, import, module management | Yes |
| `table.ts` | ~410 | TableSchema interface, column/PK/constraint schema helpers | Yes |
| `column.ts` | ~52 | ColumnSchema interface and defaults | Yes |
| `schema.ts` | ~223 | Schema class: per-schema registry of tables/views/functions | Yes |
| `schema-differ.ts` | ~284 | Declarative schema diffing and migration DDL generation | Yes |
| `catalog.ts` | ~270 | Schema catalog collection and DDL generation | Medium |
| `function.ts` | ~179 | Function schema registration (scalar, aggregate, window) | Medium |
| `change-events.ts` | ~81 | Schema change notification system | Medium |
| `declared-schema-manager.ts` | ~83 | Declared schema state management | Low |
| `window-function.ts` | ~57 | Window function schema definitions | Low |
| `view.ts` | ~20 | View schema definition | Low |
| `assertion.ts` | ~22 | Global assertion schema | Low |
| `schema-hasher.ts` | ~27 | Schema hashing utilities | Low |

### Integration Points to Review

1. **Schema → Planner**: How schema metadata flows to query planning
2. **Schema → Runtime**: How DDL execution modifies schema state
3. **Schema → Virtual Tables**: How VTab modules interact with schema
4. **Schema → Isolation Layer**: How schema changes participate in transactions

## Specific Issues Identified

### 1. Large Functions — RESOLVED

**`manager.ts:createTable()`** (~227 lines) and **`importTable()`** (~122 lines)
- **Status: RESOLVED** — Extracted 6 shared helpers, eliminating the critical DRY violation between these methods. Both now delegate to `resolveModuleInfo()`, `buildTableSchemaFromAST()`, etc.

**`manager.ts:createIndex()`** (~102 lines)
- **Status: RESOLVED** — Extracted `buildIndexSchema()`, `addIndexToTableSchema()`, `emitAutoSchemaEventIfNeeded()`.

**`schema-differ.ts:computeSchemaDiff()`** (~100 lines)
- **Status: Acceptable** — Already well-structured with clean helpers (`applyTableDefaults`, `applyIndexDefaults`, `computeTableAlterDiff`).

### 2. DRY Violations — RESOLVED

**`createTable()` / `importTable()` duplication** in `manager.ts`
- **Status: RESOLVED** — Shared logic extracted to `buildTableSchemaFromAST()`, `resolveModuleInfo()`, `buildColumnSchemas()`, `extractCheckConstraints()`.

### 3. Error Handling — Acceptable

- `manager.ts` consistently uses `QuereusError` with appropriate `StatusCode` values
- All catch blocks properly extract messages and preserve error codes
- No generic `Error` throws found (only `e instanceof Error` guards in catch blocks)

### 4. Type Safety Concerns

**`table.ts:columnDefToSchema()`**
- **Status: RESOLVED** — Removed `Partial<ColumnSchema>` cast, now uses concrete `ColumnSchema` type

**`manager.ts:importTable()`**
- Remaining: `effectiveModuleArgs as BaseModuleConfig` cast — should use type guard

**`function.ts`**
- Uses `any` generics for `AggregateReducer<T = any>` — acceptable, documented with eslint-disable

### 5. Memory/Performance Concerns

- Schema registries use standard `Map` — no unbounded growth concern (tables are explicitly added/removed)
- `schema-differ.ts` does full schema scan per diff — acceptable for current scale, could add incremental tracking for large schemas

## Test Coverage Gaps

### Missing sqllogic Tests

- DDL lifecycle: CREATE → ALTER → DROP sequences within a single test file
- Schema + transaction interaction: schema changes within savepoints, rollback behavior
- Declarative schema: `declare schema` / `apply schema` edge cases (empty schemas, no-op diffs)

### Missing Unit Tests

**File: `column.ts`**
- Virtual column expression handling
- Default value coercion
- Collation validation against type

**File: `function.ts`**
- Function overload resolution
- Aggregate vs scalar function registration

### Test Scenarios to Add

1. **Constraint Validation**
   - Create CHECK constraint with invalid expression → should fail
   - Create duplicate constraint names → should fail

2. **Declarative Schema**
   - Diff schemas with 100+ tables → performance test
   - Apply schema with type changes → validate compatibility

## Remaining Refactoring Candidates

### Medium Priority

1. **Add typed SchemaEvent discriminated union** (`change-events.ts`)
   - Type-safe event handling for schema changes
   - Better IDE support and prevents runtime errors

2. **Implement centralized schema validation layer**
   - Pre-modification validation before any schema change
   - Consistent error handling and messages

## TODO

### Phase 1: Code Quality Improvements
- [x] Decompose `createTable()`/`importTable()` in `manager.ts` — extracted 6 shared helpers (`resolveModuleInfo`, `buildColumnSchemas`, `extractCheckConstraints`, `buildTableSchemaFromAST`, `validateDefaultDeterminism`, `finalizeCreatedTableSchema`)
- [x] Decompose `createIndex()` in `manager.ts` — extracted `buildIndexSchema`, `addIndexToTableSchema`, `emitAutoSchemaEventIfNeeded`
- [x] Fix unsafe `Partial<ColumnSchema>` cast in `table.ts:columnDefToSchema()` — now uses concrete `ColumnSchema` type
- [x] Fix JSDoc `@throws Error` → `@throws QuereusError` in `schema.ts:addView()`
- [x] Replace `effectiveModuleArgs as BaseModuleConfig` cast — removed cast in `manager.ts` (called via `AnyVirtualTableModule` so `any` config accepted); typed `emitAutoSchemaEventIfNeeded` event param as `VTableSchemaChangeEvent`
- [x] `computeSchemaDiff()` in `schema-differ.ts` — reviewed, ~100 lines with clean helpers, no changes needed

### Phase 2: Test Coverage
- [x] Add sqllogic tests for DDL lifecycle — `test/logic/10.1-ddl-lifecycle.sqllogic` (7 test categories: basic lifecycle, IF NOT EXISTS, index lifecycle, transactions, error cases, multi-table, re-create after drop)
- [x] Add sqllogic tests for column features — `test/logic/10.2-column-features.sqllogic` (defaults, collation NOCASE/BINARY/RTRIM, NOT NULL behavior, type system interactions)
- [x] Add sqllogic tests for function features — `test/logic/10.3-function-features.sqllogic` (aggregate vs scalar, argument validation, window functions, type coercion)
- [x] Add schema scale test — `test/logic/10.4-schema-scale.sqllogic` (20 tables, indexes, cross-table joins, full cleanup)

### Phase 3: Documentation
- [x] Create `docs/schema.md` with full API reference — SchemaManager API, Schema Change Events, key types, error handling, declarative schema

### Phase 4: Refactoring
- [x] Add typed SchemaEvent discriminated union — `SchemaChangeEvent` union with `TableAddedEvent`, `TableRemovedEvent`, `TableModifiedEvent`, `FunctionAddedEvent`, etc. in `change-events.ts`
