---
description: Review functions subsystem fixes, tests, and documentation
prereq: none

---

# Functions Subsystem Review

Review of the comprehensive functions subsystem implementation covering critical fixes, test coverage, and documentation.

## What Was Done

### Code Fixes

1. **DRY refactoring of trim functions** (`src/func/builtins/string.ts`): Extracted `trimWithChars()` helper and `createTrimFunc()` factory, replacing three copies of identical regex-escaping logic in `trim`, `ltrim`, `rtrim`.

2. **Accumulator mutation bugs** fixed in three locations:
   - `string_concat` aggregate in `string.ts` - was mutating with `push()`, now returns `[...acc, value]`
   - `json_group_array` aggregate in `json.ts` - same fix
   - `json_group_object` aggregate in `json.ts` - now returns `{ ...acc, [key]: value }`

3. **`instr()` NULL handling** (`string.ts`): Changed to return `null` for NULL inputs (was returning `0`), matching SQLite behavior.

4. **`reverse()` Unicode handling** (`string.ts`): Changed from `split('').reverse()` to `Array.from(str).reverse()` for proper multi-codepoint character support.

5. **`lpad`/`rpad` robustness** (`string.ts`): Extracted `buildPadding()` helper that guards against empty pad strings and uses `Math.ceil(needed / pad.length)` with `.substring(0, needed)` for exact-length padding with multi-character pad strings.

6. **Duplicate function registration** (`index.ts`): Removed duplicate registration of 9 type conversion functions that were listed twice in `BUILTIN_FUNCTIONS` array.

7. **JSON path resolution regex bug** (`json-helpers.ts`): Fixed `[^[.\\s]` which was treating `\s` as literal backslash + 's', breaking path resolution for keys containing 's' (like `$.items`).

### Test Coverage Added

Five new `.sqllogic` test files:

- `06.1-string-functions.sqllogic` - trim variants, replace, instr, reverse, lpad/rpad, NULL propagation
- `06.2-math-functions.sqllogic` - sqrt, pow, floor, ceil, clamp, greatest, least, choose, iif, random, NULL propagation
- `06.5.1-conversion-functions.sqllogic` - integer(), real(), text(), boolean() conversion functions
- `06.6-aggregate-extended.sqllogic` - total, var_pop, var_samp, stddev_pop, string_concat, bigint sum overflow
- `06.7-json-extended.sqllogic` - json_patch, json_array_length with path, json_set/insert/replace semantics, NULL handling

### Documentation

- `docs/functions.md` updated to comprehensive reference covering all 80+ registered functions organized by category with signatures, descriptions, examples, and SQLite compatibility notes.

## Validation

- All 264 Mocha tests pass
- All 49 node test runner tests pass
- 0 failures

## Known Remaining Issues

Documented in `tasks/implement/3-review-core-functions.md` as future tasks:

1. **`clamp()` NULL propagation**: `Number(null)` returns 0, so `clamp(null, 0, 10)` returns 0 instead of null
2. **`json_type(null)` behavior**: Returns string `"null"` for SQL NULL input; arguably should return SQL NULL
3. **Phase 3-5 items**: Argument validation utility extraction, NULL propagation wrapper, file splitting, datetime/JSON optimizations

## Testing Focus

- Verify trim functions produce same results as before the DRY refactoring
- Verify instr() now returns NULL for NULL inputs (behavior change)
- Verify JSON path resolution works for keys containing 's' (regression test)
- Verify all new test files pass
- Verify aggregate accumulator immutability doesn't break window function state management

## TODO

- [ ] Verify code against SPP, DRY, modular criteria
- [ ] Verify all new tests pass and cover the fixes
- [ ] Check for any remaining accumulator mutation patterns
- [ ] Review json-helpers.ts regex fix for correctness
- [ ] Verify documentation accuracy against actual function behavior
