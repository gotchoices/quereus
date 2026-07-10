----
description: When the transaction-isolation layer is in use, adding a UNIQUE constraint (or an index) checks only the shared committed data and skips the rows the current connection wrote earlier in its still-open transaction, so a duplicate can slip through.
files:
  - packages/quereus-isolation/src/isolation-module.ts   # alterTable (~927), createIndex (~814), addConstraint (~1369)
  - packages/quereus-isolation/src/isolated-table.ts     # per-connection overlay state
  - packages/quereus-store/src/common/store-module.ts    # validateUniqueOverExistingRows — the analogous fix, already landed
  - packages/quereus-store/test/isolated-store.spec.ts   # harness for a store behind the isolation layer
difficulty: medium
----

# Row-validating DDL under the isolation layer skips the connection's own uncommitted rows

## Background

The isolation layer (`packages/quereus-isolation/`) gives each connection a private
overlay holding the rows it has written but not yet committed. Reads by that
connection merge the overlay over the shared underlying table (read-your-own-writes).

`IsolationModule.alterTable` and `IsolationModule.createIndex` delegate straight to the
underlying module. The underlying module then validates existing rows by scanning its
*own* data — which does not contain this connection's overlay rows, because those have
not been pushed down yet. So the row-validating DDL statements never see the writes the
issuing transaction itself made.

## Expected behavior

Row-validating DDL sees exactly the rows a `select` in the same transaction would see.
Concretely, under the isolation layer:

```sql
begin;
insert into t values (1, 'a'), (2, 'a');
alter table t add constraint u unique (v);   -- must raise "UNIQUE constraint failed"
commit;                                      -- today: table holds a duplicate under a UNIQUE constraint
```

Same expectation for:
- `create unique index … on t (v)` over colliding overlay rows.
- `alter table t alter column v set collate nocase` when the new collation makes two
  overlay rows collide under a covering UNIQUE constraint.

## Relationship to the already-fixed backends

Two sibling fixes closed the same hole one layer down, and are the template here:

- **store backend** (landed): `StoreModule.validateUniqueOverExistingRows` now takes an
  `AsyncIterable<KVEntry>` and callers pass `table.iterateEffectiveEntries(...)` — the
  committed rows merged with the open transaction's pending puts/deletes.
- **memory backend**: `bug-memory-ddl-validation-ignores-pending-rows`.

Neither helps when the isolation layer sits on top, because the pending rows then live in
the isolation overlay, not in the backend's own pending state.

## Investigation notes for whoever picks this up

- Decide where validation belongs. Either the isolation layer validates its overlay rows
  against the incoming constraint *before* delegating (it already has a pre-validation
  hook — `validateOverlayMigration`, called for the ADD COLUMN backfill checks), or the
  overlay rows are made visible to the underlying module's scan. The former looks closer
  to the existing atomicity design: `alterTable`'s doc comment states the ALTER must fail
  clean while underlying + catalog + every overlay are untouched.
- Only the ISSUING connection's overlay is in scope for rejection. A foreign connection's
  overlay may hold rows that would collide; those are that connection's problem when it
  commits, exactly as an ordinary concurrent duplicate insert would be. Don't widen this
  into cross-connection constraint checking.
- Repro harness: `packages/quereus-store/test/isolated-store.spec.ts` already wires a
  store module behind the isolation layer.
