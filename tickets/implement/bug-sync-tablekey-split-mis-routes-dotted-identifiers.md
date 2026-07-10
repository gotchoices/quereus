description: A table whose quoted name contains a dot (like "a.b") can sync to the wrong table, or be silently dropped from a snapshot, because the sync engine reconstructs the table's name by splitting a combined "schema.table" string back apart.
files:
  - packages/quereus-sync/src/sync/store-adapter.ts     # groupChangesByTable + consuming loop (~196-233)
  - packages/quereus-sync/src/sync/snapshot.ts           # getSnapshot() (~39-89)
  - packages/quereus-sync/src/sync/snapshot-stream.ts    # streamSnapshotChunks() (~92-179), parseBootstrapTables() (~296-308)
  - packages/quereus-sync/test/sync/_peer-harness.ts     # makePeer/localWrite/relay/collect — reuse for regression tests
  - packages/quereus-store/test/rehydrate-catalog.spec.ts  # sibling regression test, same bug shape, pattern to mirror
difficulty: easy
----

# Sync: `tableKey.split('.')` mis-routes quoted identifiers containing dots

## Confirmed repro

All 4 sites flagged in the prior fix ticket reproduce the same bug shape
already fixed in `@quereus/store` (ticket
`store-tablekey-split-mis-routes-dotted-identifiers`, landed): a composite
`"<schema>.<table>"` string is built by joining two already-known strings with
`.`, then later split back apart with `tableKey.split('.')`. A quoted SQL
identifier may legally contain a dot (`create table "a.b" (...)`), so
`'main.a.b'.split('.')` yields `['main', 'a', 'b']` and any code that
destructures `const [schema, table] = ...` silently drops the `b`.

Reproduced directly against the current code (scratch test, not committed —
built two `Peer`s via `test/sync/_peer-harness.ts`'s `makePeer`/`localWrite`,
both with `create table "a.b" (id integer primary key, v text) using store`):

- **`store-adapter.ts:198`** — `relay(p1, p2)` after `insert into "a.b" values
  (1, 'x')` on `p1` throws:
  ```
  Error: apply-to-store failed for 2 change(s): main.a.b (update): Table not
  found for external write: main.a; main.a.b (update): Table not found for
  external write: main.a
  ```
  `groupChangesByTable` joins `${change.schema}.${change.table}` into the map
  key, then the consuming loop recovers `(schemaName, tableName)` via
  `tableKey.split('.')` — `schemaName='main'`, `tableName='a'` — and
  `storeModule.getTableForExternalWrite(db, 'main', 'a')` fails to resolve.
  **A sync change to a dotted-name table cannot apply inbound at all.**

- **`snapshot.ts:69`** (`getSnapshot()`) — after the same insert,
  `peer.manager.getSnapshot()` returns
  `tables: [{ schema: 'main', table: 'a', ... }]` — the row's real owning
  table `"a.b"` is **silently renamed to `a`** in the snapshot payload.
  **Data loss / mis-routing on the sending side**, independent of the
  store-adapter bug above (a receiver that already has table `a` would
  silently absorb `"a.b"`'s rows).

- **`snapshot-stream.ts:121`** (`streamSnapshotChunks()`) — same repro via
  `peer.manager.getSnapshotStream()`: the `table-start` chunk reads
  `{ type: 'table-start', schema: 'main', table: 'a', ... }`. Same mis-routing
  as `getSnapshot()`, just on the streaming path.

- **`snapshot-stream.ts:305`** (`parseBootstrapTables()`) — not separately
  repro'd (lower-impact site — only feeds the bootstrap-finalize coarse
  `db.notifyExternalChange(table, schema)` watch invalidation, not data
  routing), but shares the exact same code shape: `completedTables` accumulates
  `` `${chunk.schema}.${chunk.table}` `` strings (built from already-separate
  fields) and `parseBootstrapTables` later does `key.split('.')` to recover the
  pair. A dotted table name here would coarse-notify the wrong table's watchers
  after a bootstrap.

## Root cause

Same shape as the store package's fixed bug: at each site, the real
`schema`/`table` strings are known individually at the point the joined key is
built (`change.schema`/`change.table`, `parsed.schema`/`parsed.table` from
`parseColumnVersionKey`, `chunk.schema`/`chunk.table`) — the joined string is
only needed as a Map/Set grouping key or dedup identity. The bug is entirely in
the *later* code that re-derives the pair by parsing the joined string instead
of carrying the already-known pair forward.

## Fix direction (per site)

**Sites 1–3 — thread the pair, stop parsing (matches the store-package fix):**

1. `store-adapter.ts` `groupChangesByTable`/consuming loop: each group's
   `DataChangeToApply[]` array already carries `.schema`/`.table` on every
   element. In the loop over `changesByTable`, read
   `const { schema: schemaName, table: tableName } = tableChanges[0]` instead
   of `tableKey.split('.')`. `tableKey` stays as the (unparsed) grouping key.

2. `snapshot.ts` `getSnapshot()`: `tableData` is `Map<string, TableRows>` keyed
   by the joined string. Change the value type to also carry the pair, e.g.
   `Map<string, { schema: string; table: string; rows: TableRows }>`, set from
   `parsed.schema`/`parsed.table` at insert time, and read `schema`/`table`
   directly off the map value when building `tables: TableSnapshot[]` — no
   split.

3. `snapshot-stream.ts` `streamSnapshotChunks()`: `tableKeys` is a
   `Set<string>` of joined keys. Change it to a
   `Map<string, { schema: string; table: string }>` populated the same way,
   and iterate `.values()` instead of splitting the key back apart.

**Site 4 — `parseBootstrapTables()` — pragmatic first-dot split, not a full
restructure:** `completedTables: string[]` is also the exact shape persisted
verbatim into `SnapshotCheckpoint.completedTables` (`manager.ts:283`, written/
read by `saveSnapshotCheckpoint`/`getSnapshotCheckpoint` in
`snapshot-stream.ts`). Restructuring it to carry structured pairs would change
a persisted/durable format — bigger blast radius than this ticket's scope,
since a checkpoint from a resumed transfer only has the flat string for
tables completed in an *earlier* session (their original `chunk.schema`/
`chunk.table` pair is gone by the time of resume). Instead, change
`parseBootstrapTables` to split on the **first** dot only
(`key.indexOf('.')` / `key.slice(0, i)` + `key.slice(i + 1)`) rather than
`key.split('.')` + array-destructure: this correctly recovers a dotted
**table** name (the case demonstrated as reachable above), while a dotted
**schema** name remains an accepted edge case — the same tradeoff the store
package's fix already accepted for `buildDataStoreName` (see its `NOTE:`
comment in `packages/quereus-store/src/common/key-builder.ts`). Add a
matching `NOTE:` comment at `parseBootstrapTables` documenting the accepted
limitation.

## Regression tests to add

Mirror `packages/quereus-store/test/rehydrate-catalog.spec.ts`'s dotted-name
test. Use `packages/quereus-sync/test/sync/_peer-harness.ts`'s `makePeer`,
`localWrite`, `relay`, and `collect` helpers (see
`packages/quereus-sync/test/sync/store-adapter-seam.spec.ts` and
`snapshot-bootstrap.spec.ts` for existing usage patterns):

- `store-adapter.ts`: two peers, both `create table "a.b" (...) using store`,
  insert on peer 1, `relay(p1, p2)`, assert the row reads back from `"a.b"` on
  peer 2 (not an error, not landed in a different table).
- `snapshot.ts`: `create table "a.b" (...)`, insert, `manager.getSnapshot()`,
  assert `tables` contains `{ schema: 'main', table: 'a.b' }` (not `'a'`).
- `snapshot-stream.ts`: same setup, iterate `manager.getSnapshotStream()`,
  assert the `table-start`/`column-versions`/`table-end` chunks carry
  `table: 'a.b'`.
- `parseBootstrapTables`: a resumed-stream test (mirror the existing "resumed
  snapshot stream preserves completed-table metadata" test in
  `store-adapter-seam.spec.ts`) where a completed table's name is dotted
  (`"a.b"`), asserting the `bootstrapFinalize` coarse
  `db.notifyExternalChange` call names the correct table.

Each new test should be confirmed to fail on the current (unfixed) code before
the fix lands (temporarily revert the fix, rerun, confirm red — as the store
package's review pass did) and pass after.

## TODO

- Fix `store-adapter.ts` `groupChangesByTable`/loop: derive `(schemaName,
  tableName)` from the grouped change, not from splitting `tableKey`.
- Fix `snapshot.ts` `getSnapshot()`: carry `(schema, table)` alongside
  `tableData`'s grouping key instead of splitting it back out.
- Fix `snapshot-stream.ts` `streamSnapshotChunks()`: same — carry the pair in
  `tableKeys` instead of splitting.
- Fix `snapshot-stream.ts` `parseBootstrapTables()`: split on the first dot
  only (not `split('.')` + destructure); add a `NOTE:` documenting the
  accepted dotted-schema-name limitation, mirroring the store package's
  `buildDataStoreName` NOTE.
- Add regression tests for all 4 sites per "Regression tests to add" above.
- `yarn workspace @quereus/sync run test` green; `yarn build` and `yarn lint`
  clean.
