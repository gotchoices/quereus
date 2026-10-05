description: On the built-in in-memory tables, an insert (or a key-changing update) that replaces an existing row by primary key skips the other UNIQUE columns' checks, so two rows can end up sharing a value declared unique. Make it check them exactly as SQLite and the persistent store backend already do.
architecture: docs/runtime.md
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts   # performInsert (~L1038) PK-REPLACE branch; performUpdateWithPrimaryKeyChange (~L1140) PK-REPLACE branch
  - packages/quereus/src/common/types.ts                # UpdateResult doc comment (~L205-212) claims replacedRow/evictedRows never co-occur — stale after fix
  - packages/quereus-store/src/common/store-table.ts    # reference behaviour (insert ~L423-481, update ~L520-615) — already correct
  - packages/quereus/src/runtime/emit/dml-executor.ts   # ~L1269 / ~L1484-1503 — already consumes replacedRow + evictedRows together
  - packages/quereus-isolation/src/isolated-table.ts    # stripTombstoneFromResult / attachEvicted — propagate overlay evictions; sanity-check under test:store
  - packages/quereus/test/logic/47.2-replace-and-or-clauses.sqllogic   # or a new 47.2.x file for the pins below
repro: verified
----

# Memory table: PK-conflict REPLACE skips secondary UNIQUE checks

## Problem

In `MemoryTableManager` (`packages/quereus/src/vtab/memory/layer/manager.ts`), when a write collides with an existing row on the primary key and the resolved PK action is REPLACE, the code writes the new row and returns immediately. It never calls `checkUniqueConstraints`, so a secondary UNIQUE column can end up duplicated. Two sites, same shape:

- `performInsert` — the `pkAction === REPLACE` branch does `recordUpsert(primaryKey, newRowData, existingRow)` and returns `{ replacedRow }`.
- `performUpdateWithPrimaryKeyChange` — the `pkAction === REPLACE` branch does `recordDelete(newPK)`, `recordDelete(oldPK)`, `recordUpsert(newPK)` and returns `{ replacedRow }`. Reachable only through a schema-level `primary key on conflict replace` (Quereus rejects `update or replace`, see 47.2 § 5).

The store backend (`store-table.ts`) does not have this gap: on PK REPLACE it falls through to `checkUniqueConstraints` and returns `replacedRow` **and** `evictedRows`. The DML executor already handles both fields on one result (types.ts doc comment says so explicitly).

## Reproduced (fix stage)

Ran a scratch sqllogic file via `yarn workspace @quereus/quereus run test:single packages/quereus/test/logic.spec.ts --grep <name>`; memory mode fails every case below, `QUEREUS_TEST_STORE=true` passes every case. Expected results confirmed against real SQLite (`sqlite3` CLI):

```sql
-- A. statement OR REPLACE: both conflicts resolved by deletion
create table T (id integer primary key, v text unique);
insert into T values (1, 'a'), (2, 'b');
insert or replace into T values (1, 'b');
select * from T order by id;
→ [{"id":1,"v":"b"}]
-- memory today: [{"id":1,"v":"b"},{"id":2,"v":"b"}]

-- B. PK-level REPLACE, UNIQUE keeps its own default (ABORT) → error
create table T2 (id integer primary key on conflict replace, v text unique);
insert into T2 values (1, 'a'), (2, 'b');
insert into T2 values (1, 'b');
-- error: UNIQUE constraint failed
-- (SQLite: "UNIQUE constraint failed: T2.v"; memory today: succeeds)

-- C. key-changing UPDATE under PK-level REPLACE, UNIQUE default ABORT → error, table unchanged
create table T3 (id integer primary key on conflict replace, v text unique);
insert into T3 values (1, 'a'), (2, 'b'), (3, 'c');
update T3 set id = 1, v = 'b' where id = 3;
-- error: UNIQUE constraint failed
select * from T3 order by id;
→ [{"id":1,"v":"a"},{"id":2,"v":"b"},{"id":3,"v":"c"}]

-- D. key-changing UPDATE, both constraints REPLACE
create table T4 (id integer primary key on conflict replace, v text unique on conflict replace);
insert into T4 values (1, 'a'), (2, 'b'), (3, 'c');
update T4 set id = 1, v = 'b' where id = 3;
select * from T4 order by id;
→ [{"id":1,"v":"b"}]

-- E. INSERT, both constraints REPLACE
create table T5 (id integer primary key on conflict replace, v text unique on conflict replace);
insert into T5 values (1, 'a'), (2, 'b');
insert into T5 values (1, 'b');
select * from T5 order by id;
→ [{"id":1,"v":"b"}]
```

Also verified in SQLite: `id ... primary key on conflict replace, v text unique on conflict ignore` + `insert into T values (1,'b')` → whole insert skipped, table unchanged (IGNORE on the secondary wins over PK REPLACE). Worth pinning too (case F).

## Fix

Per-constraint resolution already lives in `checkSingleUniqueConstraint` (`onConflict ?? uc.defaultConflict ?? ABORT`), and `checkUniqueConstraints` already excludes the row's own PK and pushes REPLACE evictions onto `evicted`. So:

- `performInsert`: in the REPLACE branch, don't return early — remember `replacedRow = existingRow` and fall through to the common tail: run `checkUniqueConstraints(targetLayer, schema, newRowData, primaryKey, onConflict, evicted)` (return its result if non-null, before any write), then `recordUpsert(primaryKey, newRowData, replacedRow ?? null)` and return `{ status: 'ok', row, replacedRow, evictedRows }`. The existing row at `primaryKey` is excluded from the check by PK, so it can't self-conflict. Keep it DRY — one tail for both cases.
- `performUpdateWithPrimaryKeyChange`: same idea. On REPLACE, remember `replacedAtNewKey` and fall through to the existing tail (`recordDelete(oldPK)` → `checkUniqueConstraints` with `newPrimaryKey` → on failure restore the old row and return). Only after the check passes, `recordDelete(newPrimaryKey, replacedAtNewKey)` then `recordUpsert(newPrimaryKey, newRowData, null)` (the order the branch uses today), and return `replacedRow` + `evictedRows`. Mirrors the store's update arm (check uniques first with both PKs excluded, then `deleteRowAt(newPk)`).
- Update the stale sentence in the `UpdateResult` doc comment (`packages/quereus/src/common/types.ts` ~L207-212): replacedRow and evictedRows now do co-occur on memory and store PK-REPLACE writes.

Evicted rows reach change tracking / row-time MV maintenance / FK cascade / auto-events through the executor's existing `processEvictions` (dml-executor.ts ~L1269 insert path, ~L1503 update path) — no executor change expected. Consider adding one assertion that an FK `on delete cascade` child of the evicted row (row 2 in case A) is removed, to prove the pipeline runs.

## Isolation-layer check

In `yarn test:store` mode the overlay is a memory table, so after the fix the overlay's own memory module will also evict overlay-resident rows on PK-REPLACE and report them as `evictedRows`; `IsolatedTable.stripTombstoneFromResult` passes those through and `attachEvicted` merges them with its own underlying-row evictions. The doc comment on `attachEvicted` says the two sources are disjoint per write (conflicting row lives in overlay XOR underlying). Overlay UNIQUE predicates are narrowed to live (non-tombstone) rows, so tombstones shouldn't false-conflict. Run `yarn test:store` to confirm no duplicate eviction reports or double FK actions.

## TODO

- Add cases A–F to a sqllogic file (extend `47.2-replace-and-or-clauses.sqllogic` or add `47.2.1-pk-replace-secondary-unique.sqllogic`); confirm they fail on memory before the fix.
- Fix `performInsert` PK-REPLACE branch (fall through to UNIQUE check; return `replacedRow` + `evictedRows`).
- Fix `performUpdateWithPrimaryKeyChange` PK-REPLACE branch the same way (check before deleting the row at the new PK).
- Optionally add an FK-cascade assertion on an evicted row.
- Update the `UpdateResult` doc comment in `common/types.ts`.
- Run `yarn workspace @quereus/quereus test`, `yarn workspace @quereus/quereus run test:store` (store/isolation path), and `yarn lint` for packages/quereus.
