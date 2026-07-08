description: In the persistent store, a table or schema whose quoted name contains a dot gets its storage location parsed wrong, so it can read or write the wrong table's data.
files:
  - packages/quereus-store/src/common/store-module.ts       # getStore: tableKey.split('.') (~1973); how tableKey is composed
difficulty: easy
----

# Store: `tableKey.split('.')` mis-routes quoted identifiers containing dots

## Problem

`StoreModule.getStore` splits a composite `"<schema>.<table>"` key on the dot to
recover the schema and table names for the underlying provider:

```ts
const [schemaName, tableName] = tableKey.split('.');
store = await this.provider.getStore(schemaName, tableName);
```

SQL identifiers may legally contain dots when quoted — e.g.
`create table main."a.b" (...)`. The table key for that object is
`main.a.b`; `split('.')` yields `['main', 'a', 'b']`, and the destructure keeps
`schemaName = 'main'`, `tableName = 'a'`, **silently dropping `b`**. The store is
then opened under the wrong name. Two quoted tables that collapse to the same
truncated pair (`"a.b"` and `"a.c"` both losing their tail, or `"a.b"` colliding
with a real table `a`) can be routed to the **same** or the **wrong** physical
store — a data-integrity hazard, not just a lookup miss.

## Expected behavior

The schema/table split must be lossless for any legal identifier, including
quoted names containing `.`. A round-trip (compose key → split key) must recover
exactly the original `(schemaName, tableName)` pair.

## Direction

The robust fix is to stop string-joining-and-splitting on a delimiter that can
appear in the payload. Options to weigh:

- **Split only on the first dot** (`indexOf('.')`) if schema names are
  guaranteed dot-free — then the remainder is the full table name. Verify that
  schema names truly cannot contain a dot before relying on this.
- **Carry the pair structurally** — thread `(schemaName, tableName)` alongside
  (or instead of) the flat `tableKey` so no parse is needed at `getStore`, and
  use the flat key only as an opaque map key. This is the sound general fix.

Trace where `tableKey` is composed (the join site that pairs with this split) so
the compose and parse stay symmetric, and check every other `tableKey.split`/
delimiter parse in the store for the same latent bug.

## Reproduction / test to add

Create a table with a quoted, dotted name (`create table "a.b" (...)` and/or a
dotted schema), insert and read back rows, and assert the data round-trips and
does not collide with a sibling table (`"a.c"` or `a`). Should fail (wrong
routing) before the fix.

## TODO

- Reproduce mis-routing with a quoted dotted table name (red test).
- Locate the `tableKey` compose site; make parse symmetric / lossless.
- Sweep for other delimiter-based identifier parses in the store.
- `yarn test` + `yarn test:store` green.
