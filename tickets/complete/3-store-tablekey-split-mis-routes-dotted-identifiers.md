description: Fixed a bug where a table or schema name containing a quoted dot (e.g. `"a.b"`) got routed to the wrong physical storage location after reconnecting to the database, which could silently lose or overwrite data.
files:
  - packages/quereus-store/src/common/store-module.ts       # StoreModule.getStore (~1967), createIndex, rebuildSecondaryIndexes, alterTable (2 sites)
  - packages/quereus-store/src/common/store-table.ts         # StoreTableModule.getStore interface (~143), StoreTable.initializeStore (~467)
  - packages/quereus-store/src/common/key-builder.ts         # buildDataStoreName — added tripwire NOTE (review)
  - packages/quereus-store/test/rehydrate-catalog.spec.ts    # regression test
difficulty: easy
----

# Store: `tableKey.split('.')` mis-routes quoted identifiers containing dots

## What changed

`StoreModule.getStore` used to reconstruct `(schemaName, tableName)` by
splitting the composite `"<schema>.<table>"` cache key on `.`. A quoted
identifier can legally contain a dot (`create table "a.b" (...)`), so
`'main.a.b'.split('.')` silently dropped the trailing segment and opened the
wrong physical store — only on a `this.stores` cache miss, i.e. the first
touch of a table's store after a fresh `StoreModule` (reconnect / rehydrate).
Fix threads `(schemaName, tableName)` through structurally instead of parsing
the key:

- `StoreTableModule.getStore` interface signature changed from
  `getStore(tableKey, config)` to `getStore(schemaName, tableName, config)`.
- `StoreModule.getStore` now takes `(schemaName, tableName, config)`, computes
  `tableKey` internally, and calls `this.provider.getStore(schemaName,
  tableName)` directly — no split.
- 4 in-package call sites updated (`createIndex`, `rebuildSecondaryIndexes`,
  both `alterTable` branches); dead `tableKey` locals removed.
- `StoreTable.initializeStore` passes `(this.schemaName, this.tableName,
  this.config)`.

## Review findings

**Verified — implementation correct.**
- Fix threads `(schemaName, tableName)` structurally; no `.split('.')` remains
  anywhere in `packages/quereus-store/src` (confirmed by sweep).
- Interface change is closed: `StoreTable` is the sole caller of the changed
  `StoreTableModule.getStore`; all other `getStore` call sites across the repo
  are `provider.getStore` (2-arg `KVStoreProvider`, unchanged) or the unrelated
  `coordinator-service.getStore`. No test mock implements the interface.
- Typecheck clean; `@quereus/store` 691 passing; earlier full `yarn test`
  (6531) and `yarn test:store` (6526) green per implement run. No pre-existing
  failures.

**Regression test — independently verified (implementer had not).** The
implement handoff flagged that the new test was never confirmed to fail on
buggy code. Did the equivalent of the suggested stash-and-rerun: temporarily
reverted `getStore` to the `split('.')` form and ran the store suite → the new
`'quoted table name ... survives reconnect'` test **failed** (690 passing / 1
failing); restored the fix → back to 691/0. The test genuinely catches the bug.
Working tree confirmed clean after restore.

**Tripwire (conditional, parked as code NOTE — not a ticket).** The fix routes
correctly into `provider.getStore(schemaName, tableName)`, but the provider's
physical store name is still composed by `buildDataStoreName` as
`{schema}.{table}` with a literal `.` delimiter (`key-builder.ts:41`). A lone
dotted identifier round-trips fine, but two distinct logical pairs differing
only in where the dot falls — `(schema 'x', table 'y.z')` vs `(schema 'x.y',
table 'z')` — collapse to the same physical name `x.y.z` and would clobber each
other. This needs a **dotted schema name** to bite, which is effectively
unreachable today, so it is genuinely conditional — recorded as a `NOTE:` at
`buildDataStoreName` (suggesting a boundary-safe encoding if dotted schemas ever
become reachable), not filed as a ticket.

**Sibling package — confirmed already tracked, not re-filed.** The same-shaped
`tableKey.split('.')` pattern in `@quereus/sync`
(`store-adapter.ts:198`, `snapshot.ts:66`, `snapshot-stream.ts:121,305`) is
tracked at `tickets/backlog/bug-sync-tablekey-split-mis-routes-dotted-identifiers.md`.
Verified it exists and is accurately scoped; did not re-file.

**Not covered (accepted).** No dedicated dotted-identifier `CREATE INDEX` /
`ALTER TABLE ADD CONSTRAINT UNIQUE` test — all 4 call sites share the one fixed
`getStore`, exercised generically by the full suites; the reconnect-path
regression test covers the failure mode that actually reproduced. Judged
lower-value; left as-is.

## Validation (review pass)

- `yarn workspace @quereus/store run typecheck` — clean.
- `yarn workspace @quereus/store run test` — 691 passing, 0 failing (fixed
  code); 690 passing / 1 failing with the fix temporarily reverted (regression
  test confirmed to catch the bug).
- Working tree restored to committed fix + review-only NOTE comment in
  `key-builder.ts`.
