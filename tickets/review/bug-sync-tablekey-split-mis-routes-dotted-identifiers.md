description: Fixed a bug where a database table whose quoted name contains a dot (like "a.b") could sync to the wrong table, or be silently dropped from a snapshot, in the sync engine (the sibling bug in the storage engine itself was already fixed separately).
files:
  - packages/quereus-sync/src/sync/store-adapter.ts     # groupChangesByTable loop (~196-198)
  - packages/quereus-sync/src/sync/snapshot.ts           # getSnapshot() (~39-90)
  - packages/quereus-sync/src/sync/snapshot-stream.ts    # streamSnapshotChunks() (~91-179), parseBootstrapTables() (~301-320)
  - packages/quereus-sync/test/sync/dotted-table-name.spec.ts  # new regression coverage, all 4 sites
  - packages/quereus-sync/test/sync/_peer-harness.ts     # reused makePeer/localWrite/relay/collect/settle
difficulty: easy
----

# Sync: `tableKey.split('.')` mis-routes quoted identifiers containing dots — FIXED

## Summary

All 4 sites identified in the fix-stage ticket reproduced the bug and are now
fixed. Root cause: a composite `"<schema>.<table>"` string was built by
joining two already-known strings with `.`, then later re-split with
`tableKey.split('.')` — a quoted SQL identifier may legally contain a dot
(`create table "a.b" (...)`), so `'main.a.b'.split('.')` yields `['main',
'a', 'b']` and `const [schema, table] = ...` silently drops the `b`.

## Fix per site

1. **`store-adapter.ts` `groupChangesByTable`/consuming loop (~196-198)** — the
   grouped `DataChangeToApply[]` already carries `.schema`/`.table` on every
   element. Now reads `const { schema: schemaName, table: tableName } =
   tableChanges[0]` instead of splitting the map's grouping key. `tableKey`
   itself is no longer destructured (kept only as the Map's opaque key).

2. **`snapshot.ts` `getSnapshot()` (~39-90)** — `tableData` changed from
   `Map<string, TableRows>` to `Map<string, { schema: string; table: string;
   rows: TableRows }>`, populated from `parsed.schema`/`parsed.table` at
   insert time. The table-snapshot build loop iterates `.values()` and reads
   `schema`/`table` directly off the map value — no split.

3. **`snapshot-stream.ts` `streamSnapshotChunks()` (~91-179)** — `tableKeys`
   changed from `Set<string>` to `Map<string, { schema: string; table:
   string }>`, populated the same way. The per-table streaming loop iterates
   `[tableKey, { schema, table }]` entries — no split. (The resumed-transfer
   `completedSet.has(tableKey)` check was already comparing full joined
   strings, not splitting — unaffected by the bug, unchanged.)

4. **`snapshot-stream.ts` `parseBootstrapTables()` (~301-320)** — NOT
   restructured to carry a pair (see the fix-stage ticket's rationale:
   `completedTables: string[]` is persisted verbatim into
   `SnapshotCheckpoint.completedTables`, so a resumed transfer's
   already-completed-in-an-earlier-session tables have no surviving
   `(schema, table)` pair to carry forward — only the flat string).
   Instead, changed to split on the **first** dot only
   (`key.indexOf('.')` + slice), which correctly recovers a dotted
   **table** name — the case demonstrated as reachable. A dotted
   **schema** name remains an accepted edge case, documented with a
   `NOTE:` comment at the function mirroring the equivalent tradeoff
   already accepted in `@quereus/store`'s `buildDataStoreName`
   (`packages/quereus-store/src/common/key-builder.ts`).

## Test coverage — how to validate

New file `packages/quereus-sync/test/sync/dotted-table-name.spec.ts`, 4 tests,
one per site, using `create table "a.b" (id integer primary key, v text)
using store`:

- **Site 1 (store-adapter)**: two real `Peer`s (via `_peer-harness.ts`'s
  `makePeer`), insert on peer 1, `relay(p1, p2)`, assert the row reads back
  from `"a.b"` on peer 2. Before the fix this THROWS (`Table not found for
  external write: main.a`) rather than returning an error result — the test
  asserts `relay()` resolves and `res.applied > 0`.
- **Site 2 (`getSnapshot`)**: insert into `"a.b"`, call
  `syncManager.getSnapshot()`, assert `tables[0]` is `{ schema: 'main', table:
  'a.b' }` (not `'a'`).
- **Site 3 (`streamSnapshotChunks`)**: same setup, drain
  `syncManager.getSnapshotStream()`, assert `table-start` /
  `column-versions` / `table-end` chunks all carry `table: 'a.b'`.
- **Site 4 (`parseBootstrapTables`)**: mirrors the existing "resumed snapshot
  stream preserves completed-table metadata" test in
  `store-adapter-seam.spec.ts` — hand-seeds a checkpoint whose
  `completedTables` is `['main.a.b']` (the already-completed, dotted table a
  resumed transfer skips re-streaming), spies on `db.notifyExternalChange`,
  runs `applySnapshotStream`, and asserts the coarse bootstrap-finalize
  notification names `'a.b'`, not `'a'`.

**Verified red-before/green-after per ticket instructions**: stashed the 3
source-file fixes (`store-adapter.ts`, `snapshot.ts`, `snapshot-stream.ts`),
reran the new spec — all 4 tests failed with the exact error shapes described
in the fix-stage ticket's repro (including the identical `Table not found for
external write: main.a` message for site 1). Restored the fix and reran — all
4 green.

## Validation run

- `packages/quereus-sync/test/sync/dotted-table-name.spec.ts` — 4/4 passing.
- `yarn workspace @quereus/sync run test` — 450/450 passing (full suite, no
  regressions).
- `yarn workspace @quereus/sync run typecheck` — clean.
- `yarn build` — clean (full monorepo).
- `yarn lint` — clean (fans out across every package; only `@quereus/quereus`
  runs real eslint+tsc-on-tests, unaffected by this change).

## Known gaps / non-issues for the reviewer

- **Site 4's dotted-schema-name edge case is intentionally NOT fixed** — see
  fix rationale above. This is the same accepted tradeoff already shipped in
  `@quereus/store`'s `buildDataStoreName`, not a new gap introduced here.
  Schema names are effectively never dotted in practice.
- No `docs/` changes: `docs/sync.md`'s one `schema.table` mention
  (`getUnknownTableStats()`'s `byTable` key format) is a stats-reporting
  convention unrelated to this routing bug — not touched.
- Did not audit `quereus-sync-client` or `sync-coordinator` packages for the
  same `tableKey.split('.')` shape — out of this ticket's listed file scope;
  worth a quick `grep -rn "split('\\.')" packages/quereus-sync-client
  packages/sync-coordinator` if broader coverage is wanted.
