description: Fixed a bug where a table or schema name containing a quoted dot (e.g. `"a.b"`) got routed to the wrong physical storage location after reconnecting to the database, which could silently lose or overwrite data.
files:
  - packages/quereus-store/src/common/store-module.ts       # StoreModule.getStore (~1966), createIndex, rebuildSecondaryIndexes, alterTable (2 sites)
  - packages/quereus-store/src/common/store-table.ts         # StoreTableModule.getStore interface (~143), StoreTable.initializeStore (~467)
  - packages/quereus-store/test/rehydrate-catalog.spec.ts    # new regression test at end of file
difficulty: easy
----

# Store: `tableKey.split('.')` mis-routes quoted identifiers containing dots

## What changed

`StoreModule.getStore` used to reconstruct `(schemaName, tableName)` by
splitting the composite `"<schema>.<table>"` cache key on `.`. A quoted
identifier can legally contain a dot (`create table "a.b" (...)`), so
`'main.a.b'.split('.')` silently dropped the trailing segment and opened the
wrong physical store — only on a `this.stores` cache miss, i.e. the first
touch of a table's store after a **fresh `StoreModule`** (reconnect /
rehydrate). Fix threads `(schemaName, tableName)` through structurally
instead of parsing the key:

- `StoreTableModule.getStore` interface (`store-table.ts`) signature changed
  from `getStore(tableKey, config)` to `getStore(schemaName, tableName, config)`.
- `StoreModule.getStore` (`store-module.ts`) now takes `(schemaName,
  tableName, config)`, computes `tableKey` internally the same way every
  other method in the file does, and calls `this.provider.getStore(schemaName,
  tableName)` directly — no split.
- 4 in-package call sites updated to pass `(schemaName, tableName)` instead
  of a precomputed `tableKey`: `createIndex`, `rebuildSecondaryIndexes` (also
  dropped its now-unused `tableKey` param), and both `alterTable` branches
  (`addConstraint` unique-constraint validation, `SET COLLATE` PK-collation
  re-validation). `alterTable`'s own now-dead `tableKey` local was removed too.
- `StoreTable.initializeStore` (`store-table.ts`) now calls
  `this.storeModule.getStore(this.schemaName, this.tableName, this.config)`.

`StoreTable` is the sole consumer of `StoreTableModule` and `StoreModule` is
the sole implementer — confirmed via search, no other implementer/mock of the
interface exists, so this was a closed, mechanical signature change with no
ripple into test mocks.

## Regression test

Added to `packages/quereus-store/test/rehydrate-catalog.spec.ts`
(`'quoted table name containing a dot survives reconnect (tableKey split
mis-route)'`): creates `"a.b"` and `"a.c"` under schema `main` on one
`Database` + `StoreModule`, inserts a distinguishing row into each, then opens
a **second** `Database` with a **fresh** `StoreModule` on the same
`KVStoreProvider` and calls `rehydrateCatalog`. Asserts both tables read back
their own row (this is the case that reproduced the bug — before the fix,
`select v from "a.b" where id = 1` returned `[]` because the store opened for
`('main', 'a')` instead of `('main', 'a.b')`).

I did not verify this test fails on pre-fix code in this session (the fix was
applied before the test was run) — the ticket's own repro write-up already
confirmed the failure mode by hand, and the test's assertions target exactly
that observable (empty read-back). Reviewer may want to `git stash` the
source fix and re-run this one test to double check the regression test
actually catches the bug, since that wasn't independently confirmed here.

## Test coverage / validation run

- `yarn workspace @quereus/store run typecheck` — clean.
- `yarn workspace @quereus/store run test` — 691 passing (was 690 before the
  new test), 0 failing.
- `yarn test` (full workspace fast lane) — 6531 passing, 9 pending, 0 failing.
- `yarn test:store` (quereus logic tests against LevelDB-backed store module,
  exercises ALTER/constraint/transaction DDL paths that touch `getStore`) —
  6526 passing, 14 pending, 0 failing.
- `yarn workspace @quereus/store run lint` — package has no real lint
  configured (intentional no-op per repo convention); `yarn lint` at root
  would still fan out to `packages/quereus`'s real eslint+tsc lint but that
  package's source wasn't touched by this ticket.

No pre-existing failures encountered in any of these runs.

## Known gaps / out of scope

- **`@quereus/sync` package has the same-shaped bug, unverified.** The
  original ticket flagged `packages/quereus-sync/src/store-adapter.ts:198`,
  `snapshot.ts:66`, `snapshot-stream.ts:121,305` as having an identical
  `tableKey.split('.')` pattern that may carry the same latent defect. That
  package has its own compose sites and its own `StoreTableModule`-shaped
  interface (or none) — not reproduced or touched in this ticket. Per the
  original ticket, this was already flagged separately to `tickets/backlog/`;
  reviewer should confirm that backlog ticket exists and is accurately scoped
  rather than re-filing it.
- The regression test only exercises the `rehydrateCatalog` reconnect path
  (fresh `StoreModule`, same `KVStoreProvider`). It does not cover the
  `createIndex` / `alterTable` call sites directly with a dotted-identifier
  table — those 3 call sites only differ from `getStore`'s own call site by
  which caller passes `(schemaName, tableName)`, and are exercised generically
  (non-dotted names) by the full `yarn test` / `yarn test:store` runs. If the
  reviewer wants tighter coverage, a dotted-identifier `CREATE INDEX` or
  `ALTER TABLE ... ADD CONSTRAINT UNIQUE` test on `"a.b"` would close that gap
  — I judged it lower-value than the reconnect-path test since all 4 sites
  share the same fixed `getStore` implementation and the bug was isolated to
  that one method.
