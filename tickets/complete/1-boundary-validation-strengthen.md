---
description: Boundary validation strengthened at all public API entry points
prereq: none
---

## Summary

All public API boundary methods now validate inputs eagerly with clear `MisuseError` messages, so internal code can trust data without re-checking.

## What was done

- **`isSqlValue()` / `describeSqlValueViolation()`** — runtime type guard and error describer added to `common/types.ts`; `isSqlValue` exported from `index.ts`
- **`Database.registerModule()`** — validates name (non-empty string), module (object with `create`/`connect`/`destroy` functions)
- **`Database.registerFunction()`** — validates schema object, name, numArgs (integer >= -1), and appropriate implementation functions
- **`Database.registerCollation()`** — validates name (non-empty string) and func (function)
- **`Database.registerType()`** — validates name, definition object, definition.name, physicalType (valid enum 0-5)
- **`Statement.bind()` / `Statement.bindAll()`** — validates each bound value is a valid SqlValue (rejects objects, functions, symbols, undefined)

## Testing

34 tests in `test/boundary-validation.spec.ts` — all pass. Covers reject and accept paths for every validated method.

## Verification

- `tsc --noEmit` — clean
- All 279 tests pass (1 pre-existing FK test failure unrelated)
- Validation is DRY (centralized `isSqlValue`), consistent (same pattern across all methods), and non-redundant
