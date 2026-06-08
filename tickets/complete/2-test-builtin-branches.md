description: Targeted sqllogic tests for untested branches in builtin functions — datetime heuristics, JSON edge cases, string patterns, aggregate overflow, scalar coercion, conversion errors
files:
  - packages/quereus/test/logic/24-builtin-branches.sqllogic
  - packages/quereus/src/func/builtins/datetime.ts
  - packages/quereus/src/func/builtins/json.ts
  - packages/quereus/src/func/builtins/string.ts
  - packages/quereus/src/func/builtins/aggregate.ts
  - packages/quereus/src/func/builtins/scalar.ts
  - packages/quereus/src/func/builtins/conversion.ts
----

## What was built

A comprehensive sqllogic test file (`24-builtin-branches.sqllogic`) targeting untested branches in 6 `func/builtins/` source files, covering ~100 test cases across datetime heuristics, JSON edge cases, string patterns, aggregate overflow/coercion, scalar function edge cases, and conversion error paths.

## Test coverage

- **datetime.ts**: Julian day heuristic parsing, epoch seconds/milliseconds fallback, out-of-range → null, YYYYMMDD lenient format, fractional seconds with subsec, modifiers (start of month/year, negative relative, chained), 20+ strftime specifiers including %j, %D, %F, %C, %I, %k, %l, %p/%P, %T, %R, %r, %w, %u, %J, %%, %z, %f, %s, combined formats, null format
- **json.ts**: json_valid edge cases (empty string, primitives), json_type detection, json_extract missing/null paths, json_insert/set/replace/remove edge cases, json_patch (empty, invalid op, non-array), json_group_array/object with empty/null inputs
- **string.ts**: substr with negative/zero start and negative length, trim with regex-special characters ([], ., *, ()), LIKE edge cases (%, _, empty matches)
- **aggregate.ts**: SUM BigInt promotion on overflow, string coercion, boolean values; GROUP_CONCAT custom/empty separators, all-null → null; var_pop/var_samp/stddev_pop/stddev_samp with hand-verified dataset; single-value boundaries; MIN/MAX with nulls; TOTAL with non-numeric
- **scalar.ts**: coalesce (skip nulls, all null, first wins), nullif (equal/unequal/null-null), iif (string/boolean conditions), choose (boundaries, past end, negative), greatest with nulls, typeof for booleans and json objects
- **conversion.ts**: integer/real error on non-numeric strings, null on empty string, boolean error on empty, boolean yes/no/on/off support

## Review findings

- All 1412 tests pass (2 pending, pre-existing)
- Build succeeds
- No overlap with existing test files — this file targets edge case branches specifically
- Statistical calculations verified against manual computation
- Source code quality is solid: DRY (shared reducers, factory functions), well-decomposed, proper error handling
- Known limitation: `;` in string literals treated as statement separator by test runner, worked around with `|` separator

## Usage

Tests run automatically as part of `yarn test` — the sqllogic test runner auto-discovers all `.sqllogic` files in `packages/quereus/test/logic/`.
