description: In the persistent store, a table or schema whose quoted name contains a dot gets its storage location parsed wrong after a reconnect, silently losing or overwriting the wrong table's data.
files:
  - packages/quereus-store/src/common/store-module.ts       # StoreTableModule.getStore impl (~1970), 4 call sites, StoreModule.stores cache
  - packages/quereus-store/src/common/store-table.ts         # StoreTableModule interface (~140), StoreTable.initializeStore (~463)
  - packages/quereus-store/test/rehydrate-catalog.spec.ts    # pattern to copy for the regression test (fresh-module reconnect)
difficulty: easy
----

# Store: `tableKey.split('.')` mis-routes quoted identifiers containing dots

## Confirmed repro

`StoreModule.getStore` (`packages/quereus-store/src/common/store-module.ts:1970`)
splits a composite `"<schema>.<table>"` key on the dot to recover the pieces for
the underlying provider:

```ts
async getStore(tableKey: string, _config: StoreTableConfig): Promise<KVStore> {
	let store = this.stores.get(tableKey);
	if (!store) {
		const [schemaName, tableName] = tableKey.split('.');
		store = await this.provider.getStore(schemaName, tableName);
		...
```

A quoted SQL identifier may legally contain a dot, e.g. `create table "a.b" (...)`.
Its `tableKey` is `main.a.b`; `split('.')` yields `['main', 'a', 'b']` and the
destructure keeps `schemaName = 'main'`, `tableName = 'a'` — silently dropping the
`b`. `provider.getStore('main', 'a')` is called instead of `('main', 'a.b')`.

**Why it doesn't show up on the happy path.** `create()` (line ~481) and
`connect()` build the store directly from the already-separate
`tableSchema.schemaName` / `tableSchema.name` — `this.provider.getStore(schemaName,
tableName)` — and cache the result under the correct full `tableKey`. The buggy
split only executes on a **cache miss** of `this.stores`, i.e. `getStore(tableKey,
config)` called through the `StoreTableModule` interface. That happens on
`StoreTable.initializeStore()` (`store-table.ts:463`) the first time a table's
store is touched after a **fresh `StoreModule` instance** (reconnect / rehydrate) —
the freshly-constructed module's `stores` Map is empty even though the physical
data is still there under the provider.

**Verified reproduction** (ad hoc spec, not committed — see TODO to add it for
real): create `"a.b"` and `"a.c"` (both under schema `main`) on one `Database` +
`StoreModule`, insert a row into each, close. Open a **second** `Database` with a
**new** `StoreModule` on the same `KVStoreProvider` and call
`mod2.rehydrateCatalog(db2)` (mirrors `rehydrate-catalog.spec.ts`). Querying
`select v from "a.b" where id = 1` on `db2` returns `[]` instead of the inserted
row — the row is unreachable because `getStore` opened the provider store for
`('main', 'a')` instead of `('main', 'a.b')`. (`"a.c"` collapses to the same
wrong pair too, so a collision variant is also easy to construct: same `id`
values in both tables would land in the same physical store and one would
silently clobber the other.)

## Root cause

`getStore` is the only place in the `@quereus/store` package that reconstructs
`(schemaName, tableName)` by parsing the composed `tableKey` string. Everywhere
else `tableKey` is built (`` `${schemaName}.${tableName}`.toLowerCase() ``,
throughout `store-module.ts`: `create`, `connect`, `destroy`,
`tearDownTableStorage`, `getOrReconnectTable`, `createIndex`, `alterTable`,
`renameTable`, `getTable`) it is used purely as an **opaque Map key** — never
split apart. Confirmed via a full sweep of `.split('.')` in
`packages/quereus-store/src` — this is the only occurrence in the package.

(Sibling packages `quereus-sync` — `store-adapter.ts:198`, `snapshot.ts:66`,
`snapshot-stream.ts:121,305` — have the same-shaped `tableKey.split('.')`
pattern and may carry the identical latent bug, but they're a different
package/module with their own compose sites and weren't reproduced here. Out of
scope for this ticket; flagged to `tickets/backlog/` separately.)

## Fix

Stop reconstructing `(schemaName, tableName)` from a string that can legally
contain the delimiter. Thread the pair through structurally instead of parsing
`tableKey`:

1. **`StoreTableModule.getStore` interface** (`store-table.ts` ~line 143): change
   the signature from `getStore(tableKey: string, config: StoreTableConfig)` to
   `getStore(schemaName: string, tableName: string, config: StoreTableConfig)`.

2. **`StoreModule.getStore`** (`store-module.ts` ~line 1970): accept
   `(schemaName, tableName, config)`, compute `tableKey` internally the same way
   every other method does (`` `${schemaName}.${tableName}`.toLowerCase() ``) for
   the `this.stores` cache key, and call
   `this.provider.getStore(schemaName, tableName)` directly — no split, no parse.

3. **Update the 4 in-package call sites** that currently pass a precomputed
   `tableKey` to `this.getStore(tableKey, ...)`, switching each to pass its
   already-available `schemaName, tableName`:
   - `createIndex` (~line 774)
   - `rebuildSecondaryIndexes` (~line 989) — also drop its now-unused `tableKey`
     parameter, or keep it only if still needed for something else in that method
   - `alterTable`'s `addConstraint` unique-constraint branch (~line 1337)
   - `alterTable`'s `SET COLLATE` PK-collation-changed branch (~line 1591)

4. **`StoreTable.initializeStore`** (`store-table.ts` ~line 463): change
   `this.storeModule.getStore(tableKey, this.config)` to
   `this.storeModule.getStore(this.schemaName, this.tableName, this.config)`
   (both already available as `VirtualTable` fields — no need to compute
   `tableKey` in this method at all anymore, though it may still be used in the
   error message).

No other implementer of `StoreTableModule` exists in the codebase (confirmed via
search) — `StoreTable` is the sole consumer of the interface and `StoreModule` is
the sole implementer, so this is a closed, mechanical signature change.

## TODO

- [ ] Add the regression test: extend `rehydrate-catalog.spec.ts` (or a new spec)
  with a case that creates `"a.b"` and `"a.c"` under `main`, inserts a
  distinguishing row into each, closes, reconnects with a fresh `StoreModule` on
  the same provider, calls `rehydrateCatalog`, and asserts both tables read back
  their own row correctly. Confirm it fails on current `main` before the fix
  (reproduced above: `"a.b"` reads back `[]`).
- [ ] Change `StoreTableModule.getStore` signature in `store-table.ts` to take
  `(schemaName, tableName, config)`.
- [ ] Update `StoreModule.getStore` in `store-module.ts` to match — no
  `tableKey.split('.')`.
- [ ] Update the 4 call sites in `store-module.ts` (`createIndex`,
  `rebuildSecondaryIndexes`, and the two `alterTable` branches) to pass
  `schemaName, tableName` instead of a composed `tableKey`.
- [ ] Update `StoreTable.initializeStore` in `store-table.ts` to match.
- [ ] `yarn workspace @quereus/store run test` green, including the new
  regression test.
- [ ] `yarn test` (full workspace, fast lane) green.
- [ ] `yarn test:store` (quereus logic tests against the store module) green —
  exercises more DDL paths that touch `getStore`.
- [ ] `yarn workspace @quereus/store run typecheck` / lint clean (signature
  change ripples to any test mocks implementing `StoreTableModule` directly —
  none found in the current sweep, but re-check after the interface edit).
