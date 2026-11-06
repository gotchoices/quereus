# Event System

> **Stability: Stable** — see [Stability Tiers](stability.md#tiers).

Quereus provides a database-level event system for reactive applications. Events are emitted for data changes (inserts, updates, deletes) and schema changes (table/index/column creation, alteration, dropping) across all virtual table modules. This document covers subscribing to data and schema changes, the fields each event carries and the row-key contract, how events recorded before a mid-transaction `ALTER` are rewritten for delivery, what each DDL statement reports, per-table subscription, and transaction batching. A satellite of [Usage Guide](usage.md).

## Subscribing to Data Changes

```typescript
const unsubscribe = db.onDataChange((event) => {
  console.log(`${event.type} on ${event.schemaName}.${event.tableName}`);
  console.log(`Module: ${event.moduleName}, Remote: ${event.remote}`);

  if (event.type === 'update') {
    console.log('Changed columns:', event.changedColumns);
    console.log('Old row:', event.oldRow);
    console.log('New row:', event.newRow);
  }
});

// Perform some operations
await db.exec("insert into users (id, name) values (1, 'Alice')");
// Event fires: { type: 'insert', tableName: 'users', ... }

// Unsubscribe when done
unsubscribe();
```

The `DatabaseDataChangeEvent` interface:

| Field | Type | Description |
|-------|------|-------------|
| `type` | `'insert' \| 'update' \| 'delete'` | The mutation operation |
| `moduleName` | `string` | The virtual table module that raised the event |
| `schemaName` | `string` | Schema containing the table |
| `tableName` | `string` | Table name |
| `key` | `SqlValue[]` | Primary key values projected out of the event's **own** row image (`newRow` for insert/update, `oldRow` for delete), under the primary key the table has at delivery |
| `oldRow` | `Row` | Previous row data (for update/delete) |
| `newRow` | `Row` | New row data (for insert/update) |
| `changedColumns` | `string[]` | Column names that changed (for updates) |
| `remote` | `boolean` | `true` if the change originated from a sync/remote source |

`oldRow` / `newRow` are **positional**: pair value *i* with column *i* of the table's schema.
The engine guarantees that pairing is safe **at delivery time**: every event a commit delivers
describes its rows in the schema current at delivery — even when the transaction changed the
table's columns (`ALTER TABLE ADD/DROP/RENAME COLUMN`, `ALTER COLUMN … SET DATA TYPE` /
`SET NOT NULL`) *after* recording the write. Events recorded before such an ALTER are rewritten
to the post-ALTER shape before the commit delivers them, and `changedColumns` only ever names
columns that exist in that schema (a `RENAME COLUMN` moves no value, so only the name changes).

`tableName` is as-of-delivery in the same way: a mid-transaction `ALTER TABLE … RENAME TO`
relabels the events the transaction already recorded, so every event a commit delivers names
the table as it exists at that moment — never a name the rename has already retired. Renames
compose within a transaction (`t` → `t2` → `t3` delivers `t3`), and a rename that happens
*between* transactions changes nothing about events already delivered, which correctly carry
the name the table had when they were delivered. `key` and `oldRow`/`newRow` are untouched by
a rename, which moves no value.

`key` addresses exactly one row, and an `update` never moves it. Every producer follows the
same two clauses, so a listener can treat `key` as the row's identity without knowing anything
about the table's schema:

1. **`key` is the primary key projected out of the event's own row image** — out of `newRow`
   for an `insert` and an `update`, out of `oldRow` for a `delete`. An update therefore keys by
   the row's *post*-image, which is the row the table now holds.
2. **An `update` never moves a row.** When a statement changes a primary key such that the row
   *relocates* — its key values differ under the primary key's own comparator, which is
   per-column collation- and type-aware, not byte identity — the producer delivers a `delete`
   at the old key followed by an `insert` at the new key, **in that order**, instead of one
   `update`. A rewrite that leaves the row where it was stays a single `update`: under a
   `NOCASE` primary key, `update t set k = 'APPLE' where k = 'apple'` moves nothing, so it is
   one `update` whose `key` is the post-image `['APPLE']` the table now stores.

The split is what lets a plain listener retire the old identity. `update t set a = 2 where a =
1` on a table keyed by `a` delivers `delete key: [1]` then `insert key: [2]`, so a cache or a
change log keyed by `key` drops row `1` and adds row `2` without having to know which columns
form the key — which the event does not carry. The cost is deliberate: a relocating update
carries no `changedColumns` and no "these two events are the same row" link. **Ordering is
guaranteed; adjacency is not** — other events may be delivered between the `delete` and the
`insert`, so do not pair them positionally.

`key` is as-of-delivery too: it holds the values of the primary key the table has **at
delivery**, so a consumer that addresses rows by `key` (an incremental cache, a sync change
log) can always pair the event with a row the table now contains. A mid-transaction `ALTER
TABLE … ALTER PRIMARY KEY` re-derives the `key` of every event the transaction already
recorded, projecting it out of that event's own row image — widening `(a)` to `(a, b)` turns
a recorded `[1]` into `[1, 9]`, and narrowing turns `[1, 9]` back into `[1]`. Without that,
the delivered key would carry the retired key's arity and match no row at all. As with the
other two families, an ALTER PRIMARY KEY *between* transactions leaves already-delivered
events alone: they correctly carry the key the table had at the time. A `RENAME TO` still
leaves `key` untouched (it moves no value); only an ALTER PRIMARY KEY rewrites it.

One statement raises **no** data events even though it moves every row: `ALTER TABLE … ALTER
PRIMARY KEY` on a backend that cannot re-key in place falls back to an engine-internal rebuild
(copy every row into a shadow table with the new key, then swap it in), and that rebuild is
deliberately silent on all three channels. A re-key changes no row, so announcing the copy as a
row-per-`insert` would be wrong. See [`sql-alter.md`](sql-alter.md) § ALTER PRIMARY KEY. Both
built-in modules re-key in place and never take that path.

`changedColumns` is present on an update event only if the owning module supplies it — the
memory module and the engine's auto-event path do; the store module deliberately omits it and
leaves the per-column diff to the consumer. That per-module choice is stable: a mid-transaction
ALTER re-derives an existing `changedColumns`, but never synthesizes one that was absent.

## Subscribing to Schema Changes

```typescript
const unsubscribe = db.onSchemaChange((event) => {
  console.log(`${event.type} ${event.objectType}: ${event.objectName}`);
  if (event.ddl) {
    console.log('DDL:', event.ddl);
  }
});

await db.exec("create table orders (id integer primary key, total real)");
// Event fires: { type: 'create', objectType: 'table', objectName: 'orders', ... }

unsubscribe();
```

The `DatabaseSchemaChangeEvent` interface:

| Field | Type | Description |
|-------|------|-------------|
| `type` | `'create' \| 'alter' \| 'drop'` | The schema operation |
| `objectType` | `'table' \| 'index' \| 'column'` | Type of object modified |
| `moduleName` | `string` | The module that raised the event |
| `schemaName` | `string` | Schema name |
| `objectName` | `string` | Object name (table or index name) |
| `oldObjectName` | `string` | Previous table name (`alter table … rename to` only) |
| `columnName` | `string` | Column name (for column operations) |
| `oldColumnName` | `string` | Previous column name (for renames) |
| `oldKeyColumns` | `string[]` | Column names of the retired key, in key order (`alter table … alter primary key` only) |
| `columns` | `string[]` | The table's column names in order, as of the statement (`alter table … alter primary key` only) |
| `ddl` | `string` | DDL statement if available |
| `remote` | `boolean` | `true` if the change originated from a remote source |

### Every DDL statement announces on its success path only

A schema-change event is raised **only** for a statement that succeeded. A DDL statement that
throws announces nothing at all, on every backend — no matter how far it got before failing.

This is not free, and it is worth knowing why the engine has to work for it. Some statements
do their announcing part-way through, so a later failure has to take the announcement back:

- `create table … maintained as <body>` (and `create materialized view`) creates the backing
  table first and fills it afterwards. If the body's rows violate a `CHECK` the declaration
  itself asked for, or produce duplicate keys, the statement fails and the engine drops the
  backing table again. Without retraction you would be told a table was created and then
  dropped — and a peer device replicating those events would build and destroy a real table
  for a statement that did nothing.
- `alter table … add column <inline constraint>` on a backend that emits for itself announces
  from inside its own storage call, before the engine installs the inline constraint. A
  constraint that the backfilled rows violate unwinds the whole column.

The engine scopes each DDL statement's schema events and retracts them as the error
propagates, so both cases announce nothing. Like every other event, delivery of a successful
statement's event is batched to commit and dropped on rollback.

A declarative `apply schema` runs its generated migration DDL as ordinary statements under an
undo journal, so a migration that fails part-way is normally unwound and announces nothing at
all. The one exception is a migration a data-destroying step (`DROP TABLE`, `DROP COLUMN`,
`SET DATA TYPE`) made unrestorable: the statements before the failure stay **applied** and
announced, and only the statement that failed retracts its own. See
[Declarative Schema § Failure and restoration](schema-declarative.md#failure-and-restoration).

### What each `ALTER TABLE` arm reports

Every structural `ALTER TABLE` arm raises exactly **one** event, whether or not the storage
backend ships an emitter of its own — a backend without one is covered by the engine's own
fallback, so a subscriber sees the same facts either way:

| Statement | `type` | `objectType` | `objectName` | `columnName` | `oldColumnName` |
|---|---|---|---|---|---|
| `rename to` | `alter` | `table` | **new** table name (`oldObjectName` = old) | — | — |
| `rename column` | `alter` | `column` | table | **new** column name | old column name |
| `add column` | `alter` | `column` | table | added column | — |
| `drop column` | **`drop`** | `column` | table | dropped column | — |
| `alter column …` (all four attribute forms) | `alter` | `column` | table | altered column | — |
| `alter primary key` | `alter` | `table` | table | — | — |
| `add constraint` | `alter` | `table` | table | — | — |
| `drop constraint` | `alter` | `table` | table | — | — |
| `rename constraint` | `alter` | `table` | table | — | — |

Note `drop column` reports `type: 'drop'`, not `'alter'` — the arm removes an object.

`alter primary key` additionally carries `oldKeyColumns` — the retired key's column names, in
key order. `ddl` names only the new key, and the catalog has already swapped by the time the
event is delivered, so this is the one place the old key is still named; a subscriber that
files anything under the row key (the sync engine's per-row bookkeeping) re-files from it. It
also carries `columns`, the table's column names in order (the arm adds and drops none): the
layout of every row image a subscriber recorded for the table under this column set, so a
subscriber with no catalog of its own (a sync relay) can read a deleted row's new key out of
its stored before-image.

Every arm above also sets `ddl` to the statement's **canonical, schema-qualified SQL** — the
text a replicating peer re-executes to reproduce the alteration. The engine renders it once at
plan-build time from the *resolved* table, so `alter table orders …` on a table in schema `sales`
announces `alter table sales.orders …` regardless of how you spelled it; statement keywords are
lowercased, while identifier and data-type casing is preserved as written.

`add column` with inline constraints (`add column w text null unique`) reports **one** event on
either path, carrying the whole statement's text. A backend that emits for itself makes an extra
internal `addConstraint` round-trip per inline constraint, but those calls are marked
engine-internal and announce nothing.

The event is raised on the statement's **success** path only — an ALTER that throws announces
nothing at all, on every backend, including when the failure lands *after* a self-emitting
backend has already announced the change. That is the general DDL rule above (§ [Every DDL
statement announces on its success
path only](#every-ddl-statement-announces-on-its-success-path-only)), not an ALTER-specific one.

Two arm families report nothing on either path: the metadata-tag arms (`set tags`, `add tags`,
`drop tags`) and the materialized-view lifecycle arms (`set maintained`, `drop maintained`).
Both are catalog-only and no built-in backend announces them. The exception is a tag statement
on a table whose module implements the optional `alterTags` hook: such a module may give tags a
storage meaning that a replicating peer must replay, so the statement reports one event on
either path, `alter`/`column` with `columnName` for a column target and `alter`/`table`
otherwise.

A declarative `apply schema` runs its generated migration DDL through the ordinary statement
path, so each `alter table` the differ generates reports exactly as if you had typed it —
alongside the `create` / `drop` events the same apply already raised. A failed apply that was
restored retracts all of them (see above).

`ALTER TABLE … ALTER PRIMARY KEY` on a backend that cannot re-key in place reports its one
`alter`/`table` event like any other backend, but stays silent about the engine-internal rebuild
that carries it out (see above, and [`sql-alter.md`](sql-alter.md) § ALTER PRIMARY KEY): that rebuild
runs with this channel suppressed, so a subscriber that mirrors the catalog is never told that a
machine-named `<table>__rekey_<ms>` shadow table was created and the real one dropped — neither
of which is a change the application made.

## Per-Table Subscription via `db.getTable(...)`

`Database.getTable(schemaName, tableName)` returns a public `Table` handle (or `undefined` if the table does not exist). The handle exposes the underlying module's event emitter:

```typescript
const table = db.getTable('main', 'users');
const tableEmitter = table?.getEventEmitter();

const off = tableEmitter?.onDataChange?.((event) => {
  // event.tableName is the source table — filter when you only care about one
  if (event.tableName === 'users') {
    console.log('users changed:', event);
  }
});

// Later
off?.();
```

Notes:

- The emitter is **module-scoped**: it is the same instance shared by every table that lives under the same virtual table module. Callbacks fire for changes to any table in that module, so consumers must filter by `schemaName`/`tableName` if they only care about a single table.
- When the module does not provide an event emitter, `getEventEmitter()` returns `undefined`. Fall back to the database-level `db.onDataChange()` / `db.onSchemaChange()` listeners — the engine populates those automatically for modules without native event support.
- The handle is a snapshot taken at `db.getTable()` time. If the table is dropped or replaced, the emitter reference remains valid (the module outlives individual tables) but no further events for that specific table will be produced. Re-acquire the handle after schema changes if you need a fresh view.

## Transaction Batching

Events are batched within transactions and delivered only after a successful commit. On rollback, batched events are discarded. This ensures listeners see a consistent view of committed data.

```typescript
db.onDataChange((event) => {
  console.log('Change committed:', event.type, event.tableName);
});

await db.exec("begin");
await db.exec("insert into users (id, name) values (1, 'Alice')");
await db.exec("insert into users (id, name) values (2, 'Bob')");
// No events emitted yet — still in transaction
await db.exec("commit");
// Both insert events delivered now, after commit

await db.exec("begin");
await db.exec("insert into users (id, name) values (3, 'Charlie')");
await db.exec("rollback");
// No events — transaction was rolled back
```

Savepoint semantics are also supported: events within a savepoint are tracked separately and discarded on `ROLLBACK TO SAVEPOINT` or merged on `RELEASE`.

For module-level event integration (implementing events in custom virtual table modules), see [Database-Level Event System](./module-events.md).
