---
description: Foreign key constraint enforcement with cascading actions
prereq: Schema system, constraint pipeline, DML planner/emitter, parser
---

## Summary

Foreign key constraints are fully enforced when `pragma foreign_keys = on`. The implementation spans parsing, schema storage, plan-time constraint synthesis, runtime constraint checking, and cascading action execution.

## Key Files

- `packages/quereus/src/schema/table.ts` — `ForeignKeyConstraintSchema` interface and shared `resolveReferencedColumns` utility
- `packages/quereus/src/parser/parser.ts` — column-level and table-level FK parsing (`foreignKeyClause`, `columnConstraint`, `parseForeignKeyAction`)
- `packages/quereus/src/schema/manager.ts` — FK schema extraction from AST (column-level and table-level)
- `packages/quereus/src/planner/building/foreign-key-builder.ts` — plan-time FK constraint synthesis (EXISTS/NOT EXISTS checks)
- `packages/quereus/src/runtime/foreign-key-actions.ts` — runtime cascading actions (CASCADE, SET NULL, SET DEFAULT)
- `packages/quereus/test/logic/41-foreign-keys.sqllogic` — comprehensive FK test suite
- `docs/sql.md` section 7.6 — FK enforcement documentation
- `docs/memory-table.md` — limitations section

## Review Findings & Fixes

### DRY refactoring
- **Shared `resolveReferencedColumns`** — Duplicated column resolution logic in `foreign-key-builder.ts` and `foreign-key-actions.ts` was extracted to a single function in `schema/table.ts`.
- **`referencedColumnNames` on interface** — The `_referencedColumnNames` type assertion hack (used in 3 files) was replaced with a proper optional field on `ForeignKeyConstraintSchema`.
- **Shared `synthesizeFKSubquery`** — Duplicated SELECT/WHERE clause AST construction in `synthesizeExistsCheck` and `synthesizeNotExistsCheck` was extracted to a shared helper.

### Test coverage additions
- SET NULL on UPDATE
- SET DEFAULT on UPDATE
- Multi-column (composite) FK with CASCADE DELETE
- NULL FK column values (bypass FK checks per SQL standard)

## Test Coverage

Comprehensive test suite in `test/logic/41-foreign-keys.sqllogic` covering:
- Child-side INSERT/UPDATE validation
- Parent-side RESTRICT on DELETE/UPDATE (immediate enforcement)
- NO ACTION (deferred to commit)
- CASCADE DELETE and UPDATE
- SET NULL on DELETE and UPDATE
- SET DEFAULT on DELETE and UPDATE
- Pragma on/off behavior
- Column-level FK syntax
- Multi-column composite FKs
- NULL FK values
- Cycle detection

All 725 tests pass. Build succeeds.
