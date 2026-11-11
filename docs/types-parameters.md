# Parameter Types

> **Stability: Stable** — see [Stability Tiers](stability.md#tiers).

How a statement's parameters get their types — inferred from the values passed to `prepare()`
or declared explicitly — and what is checked when those parameters are bound on each
execution. Each parameter's type is established by the **first value bound to it** and
validated on every execution, which buys type safety without giving up a user-friendly API
for JavaScript developers. A satellite of [Quereus Type System](types.md).

## Two Ways to Specify Parameter Types

Quereus offers two approaches for specifying parameter types:

1. **Type Inference from Values** - Pass initial parameter values to `prepare()` and types are inferred
2. **Explicit Type Hints** - Pass a Map of explicit type hints to `prepare()`

## Type Inference Rules

When you pass parameter values, Quereus automatically infers the logical type based on the JavaScript type. Every inferred type is **nullable**: the value fixes the storage class the parameter accepts, never whether it may be NULL, because one execution's value says nothing about the next one's. A statement prepared with `[5]` can later run with `[null]`. To have NULL refused, declare `nullable: false` in an [explicit hint map](#examples).


| JavaScript Type | Logical Type | Example |
|----------------|--------------|---------|
| `null` | ANY | `null` |
| `number` (safe integer) | INTEGER | `42`, `0`, `-100` |
| `number` (fractional, or whole past 2^53−1) | REAL | `3.14`, `-0.5`, `1e308` |
| `bigint` | INTEGER | `9007199254740991n` |
| `boolean` | BOOLEAN | `true`, `false` |
| `string` | TEXT | `'hello'`, `''` |
| `Uint8Array` | BLOB | `new Uint8Array([1, 2, 3])` |
| `object` (plain) | JSON | `{ x: 1 }`, `[1, 2, 3]` |
| *(no value and no hint)* | ANY | `db.prepare('select ? as v')` |

The integer split is `Number.isSafeInteger`, not `Number.isInteger`: INTEGER's value space
is a safe-integer `number` or an out-of-range `bigint`, so a whole double past 2^53 − 1
inhabits REAL's space as bound — calling it INTEGER would rewrite it as an exact `bigint`
the caller never passed. The single mapping lives in `inferLogicalTypeFromValue`
(`common/type-inference.ts`) and is shared with literal typing — with one exception: a
`null` *literal* is typed NULL, but a `null` *parameter value* is typed ANY (see
[A first binding of `null`](#a-first-binding-of-null)).

A parameter with neither a bound value nor an explicit hint at plan time announces **ANY**,
not a guess: `ANY` imposes no representation constraint, its `parse` is pass-through, and it
is never identical to a declared column type, so every consumer converts. (It announced TEXT
before, which made `select ? as v` report TEXT while yielding whatever was bound.) For a
parameter that simply has no value *yet*, ANY is a provisional answer: introspecting the
statement and then binding re-announces the bound value's type, because a plan that had no
type for a parameter is discarded when one is bound.

**Note**: Strings are always inferred as TEXT type. Plain objects and arrays are inferred as JSON type. To use date/time types, either:
- Use conversion functions in your query: `date(:param)`, `time(:param)`, `datetime(:param)`
- Or pass the value through a conversion function before binding

## Type Resolution and Validation

Parameter types are established per parameter, by the first value bound to it, and validated on each execution:

1. **From that parameter's first bound value**: values handed to `prepare()`, or the first
   `bind()` / `bindAll()` / execution-time parameters (`stmt.all(params)`, `stmt.get(params)`,
   `db.eval(sql, params)`). "Nothing bound yet" is never mistaken for "typed, and there are
   none" — so `db.prepare(sql, [])`, the shape a `params = []` default argument produces,
   types nothing and leaves every parameter open.
2. **Established once, then frozen**: later bindings of the *same* parameter are validated
   against its type, never re-inferred. A statement whose parameters are all bound before it
   plans is compiled exactly once.
3. **At most one extra compile per late-typed parameter**: a plan built while a parameter had
   no type — because nothing was bound yet, or only some parameters were — is discarded when
   that parameter is first bound, so the executed plan sees its real type. This is what a
   caller who introspects (`getColumnNames()`, `getColumnDefs()`, `isQuery()`,
   `getPlanShape()`, `getChangeScope()`) before binding pays.
4. **At execution time**: Parameter values are validated against the established types
5. **No recompilation on value change**: Prepared statements are NOT recompiled when parameter values change
6. **Type safety**: Attempting to execute with incompatible types throws an error

An **explicit hint map** (option 2 below) is the exception to all of the above: it is closed,
not extended. A parameter the map does not name stays ANY however it is later bound, and bound
values are not validated against it. That is a deliberate surface — the internal foreign-key
statement cache (`core/internal-statement-cache.ts`) prepares with an *empty* map to get an
affinity-neutral plan with no bind-time validation, so one cached probe can be rebound to an
integer key on one row and a text key on the next.

`db.eval(sql, params)` and `db.get(sql, params)` both plan with the types of `params`, so every entry
point answers a cross-type comparison (`where text_col = ?` bound to a number) the same way.

**Which parameter a bound key names.** Everything above is per *parameter*, not per key
spelling: the examples here write the bare `id` while [Usage](usage.md) writes `:id`, and
both name one parameter, as do `$id` and — for a positional slot — `1`, `'1'` and `':1'`.
Keys are normalized where the binding is born, so a parameter's type, its bind-time
validation and its run-time value all resolve through the same key whichever spelling the
caller used. The full contract, including why binding two spellings of one parameter in a
single object is a `MisuseError`, is stated in [Usage](usage.md) under the
prepared-statement binding methods.

### A first binding of `null`

A `null` value says nothing about what the parameter will hold on later executions, so a
parameter with no declared type whose first bound value is `null` is typed **ANY, nullable**,
and that type is frozen for the statement's life like any other (rule 2). It is not re-planned
when a non-null value arrives later: the plan built on the `null` binding stays, and ANY accepts
a value of any storage class, so `db.prepare('select ? as v', [null])` then `get([5])` and
`get(['x'])` all run. (Typing it NULL instead pinned the parameter to NULL's storage class, and
every later non-null value was rejected as a type mismatch.) An explicit hint map still wins:
this rule is about inference from values only.

The cost is that such a parameter plans as ANY everywhere it is used, which has two visible
consequences:

- **Comparisons get no column-affinity conversion.** No comparison-site coercion is minted for
  an ANY parameter, so a cross-type comparison compares storage classes as they are. With
  `create table u (k integer primary key, n integer)` holding `(1, 5)`, `where n = ?` prepared
  with `[null]` and later run with `['5']` returns nothing, while the same statement prepared
  with `['5']` (typed TEXT, so the comparison converts) returns `k = 1`. Bind the first value
  with its real type, or declare the type with a hint map, when that conversion matters.
- **LIMIT / OFFSET are checked on each execution.** `limit ?` first bound to `null` is not
  rejected when prepared; the execution with `null` fails with "LIMIT must not be NULL", and a
  later execution with `2` returns two rows (see [SQL SELECT §3.6](sql-select.md)). This holds
  for every inferred parameter, not only one first bound to `null`: an inferred type is always
  nullable, so `limit ?` first bound to `5` also takes `null` later and fails at execution.

Declaring `nullable: false` in a hint map is how a caller keeps the non-null facts: NULL is then refused at bind, and the planner treats the parameter as non-null — a LIMIT / OFFSET expression over it is judged at prepare like any non-null expression.

## Examples

**Option 1: Type inference from initial values**

```javascript
// Prepare with initial INTEGER parameters
const stmt = db.prepare('INSERT INTO users (id, age) VALUES (?, ?)', [1, 30]);

// Execute with the initial values
await stmt.run();

// Execute with different INTEGER values (no recompilation)
await stmt.run([2, 25]);
await stmt.run([3, 40]);

// This would throw an error - type mismatch (REAL vs INTEGER)
// await stmt.run([4, 25.5]); // Error: Parameter type mismatch

await stmt.finalize();
```

**Option 2: Explicit parameter types**

```javascript
import { INTEGER_TYPE, TEXT_TYPE } from '@quereus/quereus';

// Create explicit parameter types
const parameterTypes = new Map();
parameterTypes.set(1, { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false });
parameterTypes.set(2, { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false });

// Prepare with explicit parameter types
const stmt = db.prepare('INSERT INTO users (id, name) VALUES (?, ?)', parameterTypes);

// Execute with matching types
await stmt.run([1, 'Alice']);
await stmt.run([2, 'Bob']);

await stmt.finalize();
```

**Named parameters:**

```javascript
// Prepare with named parameters
const stmt = db.prepare(
  'INSERT INTO users (id, name, age) VALUES (:id, :name, :age)',
  { id: 1, name: 'Alice', age: 30 }
);

await stmt.run(); // Uses initial values
await stmt.run({ id: 2, name: 'Bob', age: 25 }); // Different values, same types

await stmt.finalize();
```

**Date/time conversion:**

```javascript
// String parameter converted to DATE in the query
await db.exec(
  'INSERT INTO events (id, event_date) VALUES (?, date(?))',
  [1, '2024-01-15']
);

// Or use conversion functions in WHERE clauses
const rows = [];
for await (const row of db.eval(
  'SELECT * FROM events WHERE event_date = date(?)',
  ['2024-01-15']
)) {
  rows.push(row);
}
```

## Type Checking and Validation

Parameter type validation ensures type safety across executions:

- **Physical type validation**: Validates that JavaScript values are compatible with the **physical type** of the declared logical type
- **Type preservation**: Once established, parameter types are preserved across all executions of a prepared statement
- **Validation on execution**: Each execution validates that parameter values match the established physical types
- **NULL compatibility**: NULL values are compatible with any nullable parameter type, and every type inferred from a value is nullable, so binding `null` to a parameter first bound to `5` is accepted (a parameter first bound to `null` is ANY and accepts both — see [A first binding of `null`](#a-first-binding-of-null)). Only a hint declared `nullable: false` rejects `null`, at bind time
- **Flexible logical types**: Different logical types with the same physical type are compatible (e.g., `number` and `bigint` both work for INTEGER physical type)
- **Canonical form at bind**: A bound value is canonicalized as it is stored (see [Physical representation](types.md#physical-representation)) — a `bigint` inside the safe-integer range narrows to `number`, so `stmt.bind(1, 5n)` is used, stored, and returned as `5`
- **No implicit conversion**: Physical type mismatches are rejected with clear error messages
- **Explicit conversion**: Use conversion functions like `integer()`, `real()`, `text()`, `date()`, etc. in your SQL to convert between types
- **Array/object scalar guard**: A parameter used directly (through `CAST`s) as a comparand in a scalar comparison (`= <> < <= > >=`, `IN`, `BETWEEN`) against a non-object scalar operand may not be bound to a JS array or plain object. The OBJECT storage class sorts above every scalar, so such a binding could never match — instead of silently returning no rows it throws `StatusCode.MISMATCH` at bind time (e.g. `where id = ?` with `[[1, 2]]`). JSON-vs-JSON comparisons (`jsoncol = :p`, and an explicit `cast(col as json) = :p`), function arguments (`json_array_length(?)`), projections (`select ? as v`), and storing into a JSON column are never flagged. Collected by `src/planner/analysis/scalar-param-usage.ts` from the logical plan. The counterpart's type is read *through* the coercion casts the planner mints for a comparison (`id = ?` with a JSON-typed `?` is built as `cast(id as json) = ?`) — without that the guard would see an OBJECT counterpart and go silent on every path that types its parameters; user-written casts stay opaque, so a deliberate JSON comparison is still allowed. One consequence: comparing a **text** column to an array-bound parameter (`textcol = :p`) is rejected even though the [JSON coercion](types.md#special-types) would have made it match a row whose text is that array's JSON source — the guard reads through the minted `cast(textcol as json)` to the column's own TEXT type and fires. Write `cast(textcol as json) = :p` to opt into the JSON comparison.

**Examples of physical type compatibility:**
- INTEGER physical type accepts: `number` (integer), `bigint`
- REAL physical type accepts: `number` (any)
- TEXT physical type accepts: `string` (any string, including date-like strings)
- BOOLEAN physical type accepts: `boolean`
- BLOB physical type accepts: `Uint8Array`
- OBJECT physical type accepts: plain objects, arrays (for JSON)
- A parameter declared ANY accepts a value of any storage class, and NULL only if the hint is nullable

## Performance Benefits

The parameter type system provides significant performance benefits:

1. **No recompilation**: Prepared statements are compiled once and reused, avoiding expensive recompilation
2. **Early validation**: Type errors are caught before execution begins
3. **Optimized plans**: The query planner can optimize based on known parameter types
4. **Future optimizations**: The system is designed to support automatic recompilation for significant optimizations (e.g., when NULL constants enable better plans)

## Implementation Details

**Key files:**
- `src/core/database.ts` - `prepare()` accepts parameter values or explicit types; `_buildPlan()` passes parameter types to planning
- `src/core/statement.ts` - Statement class manages parameter types and validation
- `src/core/param.ts` - `getParameterTypes()` infers types from parameter values (a bare `name` key takes precedence over the `:name` spelling of the same parameter, matching the bind-time value lookup)
- `src/types/logical-type.ts` - `getPhysicalType()` determines physical type from JavaScript values; `physicalTypeName()` provides human-readable names
- `src/planner/scopes/param.ts` - `ParameterScope` receives parameter types directly and uses them during planning

**Design:**
- Parameter types (not dummy values) are passed directly to the planner
- The planner works with precise logical types from the start
- No intermediate conversion to/from dummy parameter values
- Clean separation between type inference (from JS values) and type usage (in planning)
- Validation checks physical type compatibility, not exact logical type matching

