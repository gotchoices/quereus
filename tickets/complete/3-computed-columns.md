---
description: GENERATED ALWAYS AS computed columns (STORED and VIRTUAL) — reviewed and complete
prereq: none
files:
  - packages/quereus/src/schema/column.ts
  - packages/quereus/src/schema/table.ts
  - packages/quereus/src/parser/lexer.ts
  - packages/quereus/src/planner/building/insert.ts
  - packages/quereus/src/planner/building/update.ts
  - packages/quereus/src/planner/nodes/update-node.ts
  - packages/quereus/src/planner/validation/determinism-validator.ts
  - packages/quereus/src/runtime/emit/update.ts
  - packages/quereus/src/runtime/emit/alter-table.ts
  - packages/quereus/test/logic/41-generated-columns.sqllogic
  - docs/sql.md
---

## Summary

Implements `GENERATED ALWAYS AS (expr) [STORED|VIRTUAL]` computed columns with full INSERT, UPDATE, and ALTER TABLE support.

## Review Notes

### Code Quality
- Schema extension is minimal and clean (`generated`, `generatedExpr`, `generatedStored` on `ColumnSchema`)
- Two-stage INSERT projection (expand → compute generated) is well-factored and avoids circular references by scoping generated columns out
- UPDATE uses a clean two-phase evaluation: regular assignments first, then generated column recomputation via `withRowContext`
- Determinism validation follows established patterns and is applied at plan time on both paths
- ALTER TABLE constraint reconstruction properly preserves generated column metadata
- No DRY violations; generated column logic is concentrated in clear, focused functions

### Test Coverage
Tests in `41-generated-columns.sqllogic` cover:
- Basic STORED generated column (insert, select, update)
- INSERT with default values on non-generated columns
- UPDATE triggers recomputation (both input columns)
- Error: INSERT into generated column (explicit and implicit column lists)
- Error: UPDATE generated column
- SELECT * includes generated columns
- String concatenation expressions
- NOT NULL constraint on generated column (NULL propagation)
- CHECK constraint on generated column
- Error: DEFAULT + GENERATED on same column
- Multiple generated columns on same table
- RETURNING with generated columns (INSERT and UPDATE)
- VIRTUAL generated columns (insert, select, update, errors)
- Default mode (omitted STORED/VIRTUAL → VIRTUAL per SQL standard)

### Documentation
`docs/sql.md` covers syntax, examples, behavioral rules, and EBNF grammar for generated columns.

### Known Limitations (accepted)
- VIRTUAL columns currently stored identically to STORED (storage optimization deferred)
- Generated columns cannot reference other generated columns (no dependency ordering)
- UPSERT DO UPDATE path does not recompute generated columns after update assignments

### Validation
- Build: passes
- All 731+ tests pass across all suites (0 failures)
