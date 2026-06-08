description: Edge-case aggregate sqllogic tests
files:
  packages/quereus/test/logic/25-aggregate-edge-cases.sqllogic
  packages/quereus/src/func/builtins/aggregate.ts
  packages/quereus/src/func/builtins/json.ts
  packages/quereus/src/runtime/emit/hash-aggregate.ts
  packages/quereus/src/runtime/emit/aggregate.ts
----

Added `25-aggregate-edge-cases.sqllogic` covering edge cases not already tested in
07-aggregates, 06.6-aggregate-extended, and 92-hash-aggregate-edge-cases:

- HAVING eliminating all groups (sum, count, avg, complex expression)
- Type coercion: numeric-looking strings in sum/avg, non-numeric strings skipped
- Empty GROUP BY with no matching rows returns zero rows (vs scalar single-row)
- NULL-only column fed to all aggregate types simultaneously
- Nested aggregates consuming window function output (row_number, rank)
- group_concat: NULL separator fallback, all-NULL groups return null
- json_group_array: empty → null, NULLs included in array
- json_group_object: all-NULL keys → null, mixed keys
- json_group_array/object with GROUP BY
- Boolean coercion (0/1) in sum/avg
- ORDER BY aggregate alias (asc/desc)
- Mixed DISTINCT and non-DISTINCT aggregates in same query
- Single-value groups with var_samp returning NULL

**Review notes:**
- Mutable initial values (json_group_array `[]`, json_group_object `{}`) are safely
  cloned per group by `cloneInitialValue` in aggregate emitters
- Context push/pop properly guarded in try/finally in both hash and stream emitters
- All tests pass, build succeeds, no new lint issues
