description: The sync package may have the same storage-routing bug just fixed in the persistent store — a table name containing a quoted dot could get sent to the wrong table during sync.
files:
  - packages/quereus-sync/src/sync/store-adapter.ts     # line ~198: `const [schemaName, tableName] = tableKey.split('.');`
  - packages/quereus-sync/src/sync/snapshot.ts           # line ~66: same pattern
  - packages/quereus-sync/src/sync/snapshot-stream.ts    # lines ~121, ~298-305: same pattern
prereq: store-tablekey-split-mis-routes-dotted-identifiers
difficulty: easy
----

## Background

Ticket `store-tablekey-split-mis-routes-dotted-identifiers` (in `tickets/implement/`
or already landed) fixes a bug in `packages/quereus-store`: a composite
`"<schema>.<table>"` key was being recovered by `tableKey.split('.')`, which
mis-parses a quoted SQL identifier that itself contains a dot (e.g.
`create table "a.b" (...)`) — the split produces the wrong `(schemaName,
tableName)` pair and the wrong physical storage gets read or written.

A sweep for the same code shape (`tableKey.split('.')` / `key.split('.')`
recovering a schema+table pair) turned up matching occurrences in the
`@quereus/sync` package, which were out of scope for that ticket (different
package, different compose site, not reproduced there):

- `packages/quereus-sync/src/sync/store-adapter.ts:198`
- `packages/quereus-sync/src/sync/snapshot.ts:66`
- `packages/quereus-sync/src/sync/snapshot-stream.ts:121` and `:305`
  (the latter's comment even says "Mirrors the `tableKey.split('.')` convention
  used throughout this [package]")

## What to check

For each site: find where the `tableKey` (or `key`) being split was originally
composed, confirm whether it can ever hold a table or schema name containing a
literal `.` (quoted identifiers can), and if so whether the split silently
produces a wrong `(schemaName, tableName)` pair — routing a sync change to the
wrong table, or dropping part of the name.

If reproducible, the fix is the same shape as the store-package fix: stop
splitting a delimiter that can appear in the payload — either thread the
`(schemaName, tableName)` pair alongside the flat key instead of parsing it back
out, or (if verified safe) split only on the first dot.

## Expected behavior

A table or schema whose quoted name contains a dot must sync correctly — no
mis-routed or dropped rows — matching the store package's fixed behavior.
