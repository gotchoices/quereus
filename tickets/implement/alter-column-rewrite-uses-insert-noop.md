----
description: Changing a column's type (or adding NOT NULL) on an in-memory table silently fails to rewrite the rows already stored, because the rewrite uses an operation that does nothing when the row already exists — leaving stale values that queries can't find, or a NOT-NULL column that still holds nulls.
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts   # alterColumn: setDataType branch (~2090-2118), setNotNull backfill (~2045-2077)
  - packages/quereus/src/vtab/memory/layer/base.ts       # rebuildAllSecondaryIndexes()
  - packages/quereus/test/logic/41.2-alter-column.sqllogic  # add coverage
difficulty: easy
----

# `alter column` row rewrites use `tree.insert`, which no-ops on an existing key

## Root cause (confirmed by reproduction)

`MemoryTableManager.alterColumn` rewrites already-stored rows in two branches, both via
`tree.insert(newRow)` on the base primary B-tree:

- **SET DATA TYPE** conversion loop (manager.ts ~2114): `tree.insert(newRow)` per converted row.
- **SET NOT NULL** backfill loop (manager.ts ~2073): `tree.insert(newRow)` per NULL row being
  backfilled from the column default.

The tree is `inheritree`'s `BTree`. Its `insert` **rejects a duplicate key** — it is a no-op when
the primary key already exists (see `node_modules/inheritree/dist/b-tree.d.ts:219-226`: "on =
false if the insert failed: newEntry's new key already present"). Every row being rewritten keeps
its PK, so the insert lands on an existing key and does nothing. The converted / backfilled values
never reach the tree.

Result (reproduced on `main`, memory backend, autocommit — no transaction involved):

```sql
create table t (id integer primary key, v text);
insert into t values (1, '10'), (2, '9');
alter table t alter column v set data type integer;
select id, v, typeof(v) from t;   -- 1|'10'|text  2|'9'|text  (unconverted)
select id from t where v = 9;     -- (no rows)
```

```sql
create table t (id integer primary key, v integer null default 7);
insert into t values (1, null), (2, null), (3, 5);
alter table t alter column v set not null;   -- succeeds, no error
select id, v from t;   -- 1|null 2|null 3|5   (nulls NOT backfilled; column now lies "NOT NULL")
```

The SET NOT NULL case is the worse of the two: the ALTER reports success and leaves the table in a
state its own declared schema forbids — a NOT NULL column holding NULLs.

## The fix

Two parts, both in `MemoryTableManager.alterColumn`.

**1. Land the rewrite.** Replace `tree.insert(newRow)` with `tree.upsert(newRow)` in BOTH loops
(SET DATA TYPE conversion and SET NOT NULL backfill). `upsert` overwrites the entry at an existing
key in place (b-tree.d.ts:237). The PK never changes in either loop, so `upsert` is a pure
in-place value update. (`updateAt(path, newRow)` also works, but the collected paths are stale
after the first mutation — "Paths and iterators do NOT survive ANY mutation" — so `upsert`, which
needs no path, is the clean choice; the loops already snapshot all rows into `toConvert` /
`nullRows` before mutating, so iteration is safe.)

**2. Rebuild secondary indexes.** After a value rewrite, any secondary index on the column still
holds keys extracted from the OLD values, so an index-backed lookup misses the converted rows
(verified: an index on the converted column returns no rows for the new value until rebuilt). After
`this.baseLayer.updateSchema(finalNewTableSchema)` (~manager.ts:2172), call
`this.baseLayer.rebuildAllSecondaryIndexes()` when a physical value rewrite happened. Gate it on a
local flag (e.g. `valuesRewritten`) set inside the SET DATA TYPE conversion branch and the SET NOT
NULL backfill branch — do NOT rebuild unconditionally (a no-op metadata-only SET DATA TYPE where
physical types match, or a SET NOT NULL with zero NULL rows, should not pay the O(rows) rebuild).
Note the existing collation path already rebuilds indexes under `if (collationChanged)`; keep that
untouched and add the value-rewrite rebuild alongside it.

Both fixes were validated against a patched build: after them, the SET DATA TYPE reproduction
returns converted integer values, `where v = 9` finds the row, and an index-backed lookup on the
converted column also finds it.

## Scope / non-goals

- **Open-transaction case is a separate ticket** (`bug-alter-column-changes-ignore-open-transaction`).
  This fix targets autocommit, where `alterColumn` mutates the base layer directly and there is no
  pending transaction layer. Do not try to solve the transaction propagation here.
- **Store backend is already correct** — `StoreModule.alterColumnSetDataType`
  (`packages/quereus-store/src/common/store-module.ts`) rewrites via `mapRowsAtIndex` after flushing
  pending ops, a different (working) mechanism. No change needed there. Worth a quick sanity check
  that the store SET NOT NULL backfill path (if any) does not share the memory bug, but it is not
  expected to.

## TODO

- [ ] In `alterColumn` SET DATA TYPE conversion loop: `tree.insert(newRow)` → `tree.upsert(newRow)`.
- [ ] In `alterColumn` SET NOT NULL backfill loop: `tree.insert(newRow)` → `tree.upsert(newRow)`.
- [ ] Add a `valuesRewritten` flag set by both branches; after `updateSchema`, call
      `this.baseLayer.rebuildAllSecondaryIndexes()` when it is set.
- [ ] Extend `test/logic/41.2-alter-column.sqllogic`: (a) SET DATA TYPE text→integer converts
      existing rows, they match numeric comparisons, and an index on the column finds them;
      (b) SET NOT NULL with a nullable-column default backfills the existing NULL rows (and the
      resulting column truly holds no NULLs).
- [ ] `yarn build && yarn test` from repo root (or `yarn workspace @quereus/quereus test`); confirm
      the new cases pass and 41.x alter suite is green.
- [ ] `yarn lint` (only `packages/quereus` has a real lint; type-checks test call sites).
