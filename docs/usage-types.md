# Type System Reference

> **Stability: Stable** — see [Stability Tiers](stability.md#tiers).

How Quereus represents SQL values in JavaScript and TypeScript: the `SqlValue` union and row shapes, the SQL-to-JavaScript type mapping, the temporal, TIMESPAN, JSON, BLOB and big-integer surfaces, NULL handling and coercion, and the streaming, multi-statement and typed-result shapes the API returns. A satellite of [Usage Guide](usage.md).

## Core Type Definitions

```typescript
// All SQL values are represented by this union type
type SqlValue = string | number | bigint | boolean | Uint8Array | null;

// Rows are arrays of values
type Row = SqlValue[];

// Parameters can be positional (array) or named (object)
type SqlParameters = Record<string, SqlValue> | SqlValue[];
```

## SQL to JavaScript Type Mapping

| SQL Type | JavaScript Type | Notes |
|----------|----------------|-------|
| `NULL` | `null` | SQL NULL is JavaScript null |
| `INTEGER` | `number` or `bigint` | Small integers use `number`, large integers use `bigint` |
| `REAL` / `FLOAT` | `number` | Floating-point numbers |
| `TEXT` | `string` | Text strings |
| `BLOB` | `Uint8Array` | Binary data as typed array |
| `BOOLEAN` | `boolean` | True/false values |
| `DATE` | `string` | ISO 8601 date: `"2024-01-15"` |
| `TIME` | `string` | ISO 8601 time: `"14:30:00"` |
| `DATETIME` | `string` | ISO 8601 datetime: `"2024-01-15T14:30:00"` |
| `TIMESPAN` | `string` | ISO 8601 duration: `"PT1H30M"` (1 hour 30 minutes) |
| `JSON` | `string` | Validated JSON string |

## Temporal Types (DATE, TIME, DATETIME)

Quereus has native temporal types that store values as ISO 8601 strings and provide validation and comparison:

```typescript
// Create table with temporal columns
await db.exec(`
  create table events (
    id integer primary key,
    event_date date,
    event_time time,
    created_at datetime
  )
`);

// Insert temporal values - strings are validated and normalized
await db.exec(`
  insert into events values (
    1,
    '2024-01-15',           -- DATE
    '14:30:00',             -- TIME
    '2024-01-15T14:30:00'   -- DATETIME
  )
`);

// Use conversion functions to ensure proper type
await db.exec(`
  insert into events values (
    2,
    date('2024-03-20'),
    time('09:00:00'),
    datetime('now')
  )
`);

// Query temporal values - returned as ISO 8601 strings
for await (const event of db.eval("select * from events")) {
  console.log(event.event_date);   // "2024-01-15"
  console.log(event.event_time);   // "14:30:00"
  console.log(event.created_at);   // "2024-01-15T14:30:00"
}

// Temporal types support proper comparison and ordering
for await (const event of db.eval(`
  select * from events
  where event_date >= date('2024-01-01')
  order by created_at desc
`)) {
  console.log(event);
}
```

**Conversion Functions:**
- `date(value)` - Convert to DATE type
- `time(value)` - Convert to TIME type
- `datetime(value)` - Convert to DATETIME type
- `timespan(value)` - Convert to TIMESPAN type
- Special value: `datetime('now')` returns current timestamp

## TIMESPAN Type

Quereus has a native TIMESPAN type for representing durations and intervals:

```typescript
// Create table with timespan column
await db.exec(`
  create table events (
    id integer primary key,
    name text,
    duration timespan
  )
`);

// Insert timespan values - ISO 8601 duration strings
await db.exec(`
  insert into events values
    (1, 'Meeting', 'PT1H30M'),        -- 1 hour 30 minutes
    (2, 'Workshop', 'PT3H'),          -- 3 hours
    (3, 'Sprint', 'P14D')             -- 14 days
`);

// Use timespan() function with human-readable strings
await db.exec(`
  insert into events values
    (4, 'Break', timespan('15 minutes')),
    (5, 'Project', timespan('2 weeks 3 days'))
`);

// Temporal arithmetic: add timespan to datetime
for await (const event of db.eval(`
  select
    name,
    duration,
    datetime('2024-01-15T09:00:00') + duration as end_time
  from events
`)) {
  console.log(event);
}

// Subtract timespans
const diff = await db.prepare(`
  select timespan('2 hours') - timespan('30 minutes') as remaining
`).get();
console.log(diff.remaining); // "PT1H30M"

// Compare timespans
for await (const event of db.eval(`
  select * from events
  where duration > timespan('1 hour')
  order by duration
`)) {
  console.log(event);
}
```

**TIMESPAN Features:**
- ISO 8601 duration string format (`"PT1H30M"`, `"P1DT2H"`)
- Human-readable parsing via `timespan()` function
- Arithmetic operations with DATE, TIME, DATETIME types
- Addition and subtraction of timespans
- Proper comparison and ordering
- Stored as TEXT with validation

## JSON Type

Quereus has a native JSON type that validates JSON syntax and provides deep equality comparison:

```typescript
// Create table with JSON column
await db.exec(`
  create table users (
    id integer primary key,
    profile json
  )
`);

// Insert JSON data - validated and normalized
await db.exec(`
  insert into users values
    (1, '{"name":"Alice","age":30}'),
    (2, json('{"name":"Bob","age":25}'))
`);

// Enforce JSON structure with CHECK constraints
await db.exec(`
  create table events (
    id integer primary key,
    data json check (json_schema(data, '[{x:integer,y:number}]'))
  )
`);

// Valid insert - matches schema
await db.exec(`
  insert into events values (1, '[{"x": 1, "y": 2.5}, {"x": 2, "y": 3.14}]')
`);

// Invalid insert - fails CHECK constraint
try {
  await db.exec(`
    insert into events values (2, '[{"x": "wrong", "y": 2.5}]')
  `);
} catch (err) {
  console.log('CHECK constraint failed'); // x must be integer
}

// JSON values are compared by content, not string representation
// These two are considered equal despite different key order:
await db.exec(`insert into users values (3, '{"x":1,"y":2}')`);
await db.exec(`insert into users values (4, '{"y":2,"x":1}')`);

// Query JSON data
for await (const user of db.eval("select * from users")) {
  console.log(user.profile); // Normalized JSON string
}

// Use JSON functions to extract values
for await (const row of db.eval(`
  select
    id,
    json_extract(profile, '$.name') as name,
    json_extract(profile, '$.age') as age
  from users
`)) {
  console.log(`${row.name} is ${row.age} years old`);
}

// json() conversion function validates and normalizes
const normalized = await db.prepare("select json(?) as data").get(['{"x":1}']);
console.log(normalized.data); // '{"x":1}' (normalized)
```

**JSON Features:**
- Validates JSON syntax on insert/update
- Normalizes JSON (consistent formatting)
- Deep equality comparison (content-based, not string-based)
- Works with all existing JSON functions (json_extract, json_valid, etc.)

## Working with BLOBs

Binary data is represented as `Uint8Array`:

```typescript
// Insert binary data
const imageData = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0]); // JPEG header
await db.exec("insert into files (name, data) values (?, ?)",
  ["image.jpg", imageData]);

// Retrieve binary data
const file = await db.prepare("select data from files where name = ?").get(["image.jpg"]);
console.log(file.data instanceof Uint8Array); // true
console.log(file.data); // Uint8Array(4) [255, 216, 255, 224]

// Generate random binary data
const random = await db.prepare("select randomblob(16) as random_bytes").get();
console.log(random.random_bytes instanceof Uint8Array); // true
```

## Working with Large Integers

JavaScript `number` type is limited to safe integers (±2^53 - 1). For larger integers, Quereus uses `bigint`:

```typescript
// Small integers use number
const small = await db.prepare("select 42 as value").get();
console.log(typeof small.value); // "number"

// Large integers use bigint
const large = await db.prepare("select 9007199254740992 as value").get();
console.log(typeof large.value); // "bigint"

// You can pass bigint as parameters
await db.exec("insert into counters (id, count) values (?, ?)",
  [1, 9007199254740992n]);
```

## NULL Handling

SQL `NULL` is represented as JavaScript `null`:

```typescript
// NULL values in results
const user = await db.prepare("select name, email from users where id = ?").get([1]);
console.log(user.email === null); // true if email is NULL

// NULL in parameters
await db.exec("insert into users (name, email) values (?, ?)",
  ["John", null]); // email will be NULL

// NULL checks in SQL
const hasEmail = await db.prepare(
  "select count(*) as count from users where email is not null"
).get();
```

## Type Coercion

Quereus follows SQL type coercion rules:

```typescript
// Numeric strings are coerced in comparisons
const result = await db.prepare("select 42 = '42' as equal").get();
console.log(result.equal); // true (boolean)

// String concatenation with ||
const concat = await db.prepare("select 'Value: ' || 42 as text").get();
console.log(concat.text); // "Value: 42" (string)

// Arithmetic operations coerce to numbers
const math = await db.prepare("select '10' + '20' as sum").get();
console.log(math.sum); // 30 (number)
```

## Row Representation: Arrays vs Objects

Internally, Quereus represents rows as **arrays of values** (`Row = SqlValue[]`), but the high-level API converts them to **objects** for convenience:

```typescript
// stmt.get() returns a single object (Record<string, SqlValue>)
const user = await db.prepare("select id, name, email from users where id = ?").get([1]);
// user is: { id: 1, name: "Alice", email: "alice@example.com" }
console.log(user.name); // "Alice"

// stmt.all() returns an async iterator of objects
const stmt = await db.prepare("select id, name from users");
for await (const user of stmt.all()) {
  console.log(user.name); // Each row is an object
}
await stmt.finalize();

// db.eval() also returns an async iterator of objects
for await (const user of db.eval("select * from users")) {
  console.log(user.name); // Each user is an object
}
```

**Key Points:**
- All query methods return rows as objects with column names as keys
- Two result columns sharing a name (`select l.a, r.a from l join r …`, with or without `group by`) are numbered — the first keeps the name, later ones get a `:<n>` suffix: `a`, `a:1`. Without this the object form would drop a column; use an explicit alias when you want a stable name
- `get()` returns a single object (or undefined)
- `all()` and `eval()` return async iterators for streaming

## Async Iteration and Streaming

Quereus uses **async iterators** for streaming query results, allowing you to process large result sets without loading everything into memory:

```typescript
// db.eval returns AsyncIterableIterator<Record<string, SqlValue>>
const iterator = db.eval("select * from large_table");

// Use for-await-of to stream rows
for await (const row of iterator) {
  console.log(row); // Each row is an object
  // Rows are streamed - not all loaded into memory at once
}

// Or manually control iteration
const iter = db.eval("select * from users");
const first = await iter.next(); // { value: { id: 1, name: "Alice" }, done: false }
const second = await iter.next(); // { value: { id: 2, name: "Bob" }, done: false }
```

**Runtime Value Types:**

At the runtime level, Quereus works with these value types:

```typescript
// SqlValue: primitive values
type SqlValue = string | number | bigint | boolean | Uint8Array | null;

// Row: array of values
type Row = SqlValue[];

// RuntimeValue: what instructions can work with
type RuntimeValue = SqlValue | Row | AsyncIterable<Row> | ((ctx: RuntimeContext) => OutputValue);

// SqlParameters: how you pass parameters
type SqlParameters = Record<string, SqlValue> | SqlValue[];
```

This means:
- **Scalar queries** return a single `SqlValue`
- **Table queries** return `AsyncIterable<Row>` (streamed rows)
- **Parameters** can be positional arrays or named objects

## Multi-Statement Execution

When executing multiple statements with `db.eval`, **only the last statement's results are returned**:

```typescript
// Only the SELECT results are returned
for await (const row of db.eval(`
  create table temp_data (id integer, value text);
  insert into temp_data values (1, 'a'), (2, 'b');
  select * from temp_data;
`)) {
  console.log(row); // { id: 1, value: 'a' }, then { id: 2, value: 'b' }
}

// The CREATE and INSERT are executed, but their results are discarded
// Only the final SELECT produces rows to iterate

// If the last statement doesn't return rows, the iterator is empty
for await (const row of db.eval(`
  create table users (id integer, name text);
  insert into users values (1, 'Alice');
`)) {
  // This loop never executes - INSERT doesn't return rows
}

// Use db.exec for multi-statement DDL/DML without results
await db.exec(`
  create table users (id integer, name text);
  insert into users values (1, 'Alice');
`);
```

**Best Practices:**
- Use `db.eval()` when you need results from the last statement
- Use `db.exec()` for DDL/DML statements that don't return results
- For multiple statements with results, execute them separately

## TypeScript Type Safety

For better type safety, you can define interfaces for your result types:

```typescript
interface User {
  id: number;
  name: string;
  email: string | null;
  created_at: string; // Date/time as string
}

const user = await db.prepare("select * from users where id = ?").get([1]) as User;
console.log(user.name.toUpperCase()); // TypeScript knows name is a string

// For async iteration
for await (const user of db.eval("select * from users") as AsyncIterableIterator<User>) {
  console.log(user.email?.toLowerCase()); // TypeScript knows the shape
}
```
