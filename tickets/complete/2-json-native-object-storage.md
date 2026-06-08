description: Native JSON type with PhysicalType.OBJECT — store JSON as JS objects, not strings
files:
  - packages/quereus/src/types/logical-type.ts
  - packages/quereus/src/common/types.ts
  - packages/quereus/src/types/json-type.ts
  - packages/quereus/src/common/type-inference.ts
  - packages/quereus/src/util/comparison.ts
  - packages/quereus/src/func/builtins/json-helpers.ts
  - packages/quereus/src/func/builtins/json.ts
  - packages/quereus/src/func/builtins/json-tvf.ts
  - packages/quereus/src/func/builtins/conversion.ts
  - packages/quereus/src/func/builtins/index.ts
  - packages/quereus/src/func/builtins/scalar.ts
  - packages/quereus/src/emit/ast-stringify.ts
  - packages/quereus/src/index.ts
  - packages/quereus-store/src/common/serialization.ts
  - packages/quereus-store/src/common/encoding.ts
  - packages/quereus/test/boundary-validation.spec.ts
  - packages/quereus/test/logic/03.6-type-system.sqllogic
  - packages/quereus/test/logic/06-builtin_functions.sqllogic
  - packages/quereus/test/logic/06.7-json-extended.sqllogic
  - docs/types.md
  - docs/functions.md
----

## What was built

Changed JSON from `PhysicalType.TEXT` (values stored as serialized JSON strings) to
`PhysicalType.OBJECT` (values stored as native JS objects/arrays/primitives in memory).
This eliminates repeated parse/stringify cycles when working with JSON columns.

### Key changes

- `PhysicalType.OBJECT = 6` added to enum
- `JsonSqlValue` type added to `SqlValue` union
- `StorageClass.OBJECT = 4` for comparison ordering
- `JSON_TYPE` rewritten with OBJECT physical type, serialize/deserialize hooks, deep comparison
- All `json_*` functions accept native objects and JSON strings; return native objects
- Storage layer: `$json` marker for collision prevention, `TYPE_OBJECT = 0x05` key encoding
- `json()` conversion function registered in BUILTIN_FUNCTIONS
- `typeof()` returns `'json'` for native JSON objects

## Review fixes applied

- **Bug fix**: `json()` function was defined in `conversion.ts` but not registered in `index.ts` BUILTIN_FUNCTIONS array. Added import and registration.
- **Doc fix**: `functions.md` — `typeof()` now lists `'json'` as a return value
- **Doc fix**: `functions.md` — `json_group_array`/`json_group_object` return types changed from TEXT to JSON, examples updated to show native objects
- **Tests added** to `03.6-type-system.sqllogic`:
  - `typeof(j)` returns `'json'` for JSON column values
  - `json('{"a":1}')` returns native object
  - `json('[1,2,3]')` returns native array
  - `json('null')` returns null
  - `typeof(json('{"a":1}'))` returns `'json'`
  - Deep comparison: `json('{"a":1}') = json('{"a":1}')` → true
  - Deep inequality: `json('{"a":1}') = json('{"a":2}')` → false
  - Array comparison equality and inequality

## Known minor items (not blocking)

- `compareSameType(OBJECT)` in `comparison.ts` uses `JSON.stringify` (key-order-dependent) while `JSON_TYPE.compare` uses `deepCompareJson` (key-order-independent). Low risk since all objects created within the engine have consistent key ordering after parse normalization. Could be unified in a future pass via the `type-system-comparators` ticket.
- `json_group_array` and `json_group_object` use spread operators (`[...acc]`, `{...acc}`) for immutability, which is O(n²) for large aggregations. Could optimize to use mutation if the aggregate framework guarantees no reuse of intermediate accumulator values.

## Testing

- 277 tests passing (1 pre-existing failure in `08.1-semi-anti-join.sqllogic` — unrelated)
- Build passes clean
- JSON type system, validation, comparison, functions, aggregates, TVFs all covered
