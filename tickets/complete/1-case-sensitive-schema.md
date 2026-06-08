---
description: Fix case-sensitive schema name lookups in SchemaManager, Schema, and planner cache
prereq: none

status: complete
---

# Fix Case-Sensitive Schema Name Lookups

## Problem

Several `SchemaManager` methods failed to normalize schema names to lowercase before using them as map keys. Since the `schemas` map stores keys in lowercase, passing mixed-case names (e.g. `"App"` instead of `"app"`) caused silent lookup failures for `getView()`, `getSchemaItem()`, `getTable()`, and `dropView()`. The planner cache also used un-normalized schema names in cache keys, causing duplicate entries.

## Solution Implemented

Defensive normalization at method boundaries: every method that accepts a schema name lowercases it before any map lookup. The `Schema` constructor always receives a lowercase name.

### Files Changed

- **`packages/quereus/src/schema/manager.ts`**
  - `getView()`: Lowercased `targetSchemaName` before `this.schemas.get()`
  - `getSchemaItem()`: Lowercased `targetSchemaName` before `this.schemas.get()`
  - `getTable()`: Lowercased `targetSchemaName` before `this.schemas.get()`
  - `dropView()`: Lowercased `schemaName` before `this.schemas.get()`
  - `addSchema()`: Pass `lowerName` to `new Schema()` so `Schema.name` is always lowercase
  - `importTable()`: Create `Schema` with lowercase name (found during review)

- **`packages/quereus/src/schema/schema.ts`**
  - `addView()`: Changed to case-insensitive comparison for `view.schemaName` vs `this.name`

- **`packages/quereus/src/planner/building/schema-resolution.ts`**
  - Normalized cache keys to lowercase for both schema names and table names, preventing duplicate cache entries for the same schema referenced with different cases

### Tests Added

- `packages/quereus/test/logic/06.4.1-schema-case-insensitive.sqllogic` — covers:
  - Schema creation with mixed case
  - Table creation in mixed-case schema
  - View creation in mixed-case schema
  - Case-insensitive access to tables and views via qualified names
  - DROP operations with mixed case

### Review Notes

- All 354 tests pass (only pre-existing `self-join under 8 s` perf sentinel fails — unrelated)
- `schema-manager.spec.ts` existing case-insensitivity test still passes
- `importTable()` bug found and fixed during review: it created `Schema` objects with mixed-case `name` while the map key was lowercase
- `tableSchema.schemaName` / `viewSchema.schemaName` can still be mixed-case from parser AST; defensive `.toLowerCase()` comparisons handle this. Broader normalization of stored schema names is out of scope for this fix.

