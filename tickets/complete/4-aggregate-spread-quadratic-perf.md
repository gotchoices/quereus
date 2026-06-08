description: Fixed O(n^2) array/object spread in aggregate step functions — mutate accumulators in-place
files:
  packages/quereus/src/func/builtins/aggregate.ts
  packages/quereus/src/func/builtins/json.ts
  packages/quereus/src/runtime/emit/aggregate.ts
  packages/quereus/test/performance-sentinels.spec.ts
----
## What was built

Three aggregate step functions (`group_concat`, `json_group_array`, `json_group_object`) previously used spread operators to copy the entire accumulator on every row, resulting in O(n^2) total allocation for n rows. Fixed by mutating the accumulator in-place since aggregate accumulators are per-group and not shared.

- **group_concat**: `initialValue` changed to a factory function `() => ({ values: [], separator: ',' })` so `cloneInitialValue` creates a fresh nested array per group. Step uses `acc.values.push()` and direct `acc.separator =` assignment.
- **json_group_array**: Step uses `acc.push()` instead of `[...acc, value]`.
- **json_group_object**: Step uses `acc[key] = value` instead of `{ ...acc, [key]: value }`.
- **cloneInitialValue** (aggregate.ts:25): Handles factory functions, shallow array/object clones, and primitives to ensure each group gets an independent accumulator.

## Testing

- Performance sentinel tests (`performance-sentinels.spec.ts` "Aggregate accumulator spread"): 3 tests covering all 3 fixed functions over 1000 rows, each under 500ms threshold. All pass (~195ms total).
- Sqllogic tests (`07-aggregates.sqllogic`, `06-builtin_functions.sqllogic`): Verify correctness of aggregate results. All pass.
- Build passes cleanly.

## Usage

No API changes. `group_concat`, `json_group_array`, and `json_group_object` now scale linearly with row count instead of quadratically.
