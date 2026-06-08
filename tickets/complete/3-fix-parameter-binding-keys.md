---
description: Standardize parameter binding key types (string vs number)
prereq: none

---

# Fix Parameter Binding Key Inconsistency

## Summary

`bindAll()` was using string keys (`"1"`, `"2"`) for positional parameters while `bind()` and the constructor used numeric keys (`1`, `2`). Standardized `bindAll()` to use numeric keys, matching the rest of the codebase.

## Change

In `packages/quereus/src/core/statement.ts`, `bindAll()` was simplified to assign directly to `this.boundArgs` with numeric keys (`index + 1`) instead of creating an intermediate `Record<string, SqlValue>` with `String(index + 1)` keys.

## Testing

- Existing parameter binding tests all pass (anonymous `?`, indexed `:1`, named `:name`, mixed, `bindAll` with array/object, `bind()` method, `db.eval()`, null params, CTE params, etc.)
- New test added: `should produce consistent results between bind() and bindAll() for positional params` — verifies that using `bind(1, v); bind(2, v)` and `bindAll([v, v])` produce identical query results.
- Full test suite passes (238 tests, 0 failures).

## Validation

- The runtime consumer (`src/runtime/emit/parameter.ts`) uses `String(identifier)` for object key lookup. JavaScript coerces numeric object property keys to strings, so both `{1: val}` and `{"1": val}` work identically with the `in` operator and property access. The fix ensures consistency at the source rather than relying on implicit coercion.
- `validateParameterTypes()` iterates `parameterTypes` Map entries and looks up in `boundArgs` — this works correctly with numeric keys.
- `getParameterTypes()` in `src/core/param.ts` uses `Object.entries()` on `boundArgs` which returns string keys regardless — no issue there.
