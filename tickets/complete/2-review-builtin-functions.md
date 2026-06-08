description: Review of built-in functions (scalar, aggregate, datetime, JSON, string, conversion, window, timespan)
files:
  packages/quereus/src/func/context.ts
  packages/quereus/src/func/registration.ts
  packages/quereus/src/func/builtins/aggregate.ts
  packages/quereus/src/func/builtins/builtin-window-functions.ts
  packages/quereus/src/func/builtins/conversion.ts
  packages/quereus/src/func/builtins/datetime.ts
  packages/quereus/src/func/builtins/explain.ts
  packages/quereus/src/func/builtins/generation.ts
  packages/quereus/src/func/builtins/index.ts
  packages/quereus/src/func/builtins/json.ts
  packages/quereus/src/func/builtins/json-helpers.ts
  packages/quereus/src/func/builtins/json-tvf.ts
  packages/quereus/src/func/builtins/scalar.ts
  packages/quereus/src/func/builtins/schema.ts
  packages/quereus/src/func/builtins/string.ts
  packages/quereus/src/func/builtins/timespan.ts
----
## Findings

### defect: json_each() recursively traverses instead of yielding immediate children
file: packages/quereus/src/func/builtins/json-tvf.ts:58-103
json_each() is implemented as recursive DFS (same as json_tree), but per SQLite semantics it should only yield the immediate children of the top-level container. Also yields the root itself which SQLite does not. Tests only verify "it runs" without asserting output.
Ticket: tickets/fix/json-each-recursive-traversal.md

### defect: weekday N modifier in datetime functions moves in wrong direction
file: packages/quereus/src/func/builtins/datetime.ts:266-272
applyWeekdayAdjustment() has inverted logic — it moves backward instead of forward. E.g., on Monday targeting Wednesday, it goes back 5 days instead of forward 2. No weekday tests exist.
Ticket: tickets/fix/datetime-weekday-modifier-inverted.md

### smell: O(n^2) array/object spread in aggregate step functions
file: packages/quereus/src/func/builtins/aggregate.ts:164, json.ts:443, json.ts:458
group_concat, json_group_array, and json_group_object create new arrays/objects via spread on every step call, resulting in quadratic allocation for large datasets. Aggregate accumulators are per-group and safe to mutate.
Ticket: tickets/fix/aggregate-spread-quadratic-perf.md

### smell: sqrtFunc inferReturnType claims "always returns REAL" but preserves input type
file: packages/quereus/src/func/builtins/scalar.ts:226-228
The comment says "sqrt always returns REAL" but the inferReturnType always returns the input type unchanged. sqrt(integer) should return REAL since integer sqrt is almost always fractional.
Ticket: n/a (note — low impact since runtime always returns a JS number via Math.sqrt)

### smell: Window MIN/MAX use JS operators instead of SQL comparison
file: packages/quereus/src/func/builtins/builtin-window-functions.ts:217-245
Window aggregate step functions for MIN and MAX use JavaScript `<` and `>` operators rather than compareSqlValues/compareSqlValuesFast. This means mixed-type comparisons follow JS coercion rules, not SQL ordering semantics.
Ticket: n/a (note — window functions are a newer area; aligning with aggregate MIN/MAX comparison semantics would be a follow-up)

### note: clamp() coerces NULL to 0 via Number(null)
file: packages/quereus/src/func/builtins/scalar.ts:328-335
`clamp(NULL, 0, 10)` returns 0 because `Number(null)` is 0. Most other scalar functions (abs, round, sqrt) propagate NULL. However, the test at 06.2-math-functions.sqllogic:68-69 explicitly expects this behavior, so it is by design.

### note: json_extract multi-path returns first match, not array
file: packages/quereus/src/func/builtins/json.ts:136-166
In SQLite, `json_extract(json, path1, path2)` returns a JSON array of all extracted values. Current implementation returns the first non-null match. No multi-path tests exist.

### note: json_group_array returns null for empty set
file: packages/quereus/src/func/builtins/json.ts:444-446
SQLite returns `[]` for json_group_array on no rows; quereus returns null. Minor behavioral difference.

### note: Statistical aggregates use numerically unstable formula
file: packages/quereus/src/func/builtins/aggregate.ts:196-268
Variance computed as E[X^2] - E[X]^2 which suffers from catastrophic cancellation with large values. Welford's algorithm would be more robust. The stddev functions guard against negative variance (return null), but var_pop could return small negative values.

### note: Window SUM doesn't handle BigInt like regular SUM
file: packages/quereus/src/func/builtins/builtin-window-functions.ts:172-181
Window SUM uses `Number(value)` unconditionally, losing precision for large BigInt values. Regular sumFunc properly handles BigInt promotion.

### note: generate_series missing step parameter
file: packages/quereus/src/func/builtins/generation.ts
Only accepts (start, end), not (start, end, step). SQLite and PostgreSQL both support a step argument.

### note: schemaSizeFunc is incomplete
file: packages/quereus/src/func/builtins/explain.ts:676-700
Has a TODO comment and yields nothing. Not registered in BUILTIN_FUNCTIONS (harmless).

## Trivial Fixes Applied
- scalar.ts:423 — removed orphaned comment `// Greatest-of function` at end of file
- explain.ts:386 — fixed stackTraceFunc error-path row from 5 columns to 7 columns matching return type definition

## No Issues Found
- packages/quereus/src/func/context.ts — clean, well-structured context implementation
- packages/quereus/src/func/registration.ts — clean factory functions with good defaults
- packages/quereus/src/func/builtins/conversion.ts — clean, consistent pattern across all conversion functions
- packages/quereus/src/func/builtins/timespan.ts — clean extraction/total functions with appropriate null handling
- packages/quereus/src/func/builtins/schema.ts — clean schema introspection, error paths match column counts
- packages/quereus/src/func/builtins/json-helpers.ts — clean helper functions with good null/undefined handling
