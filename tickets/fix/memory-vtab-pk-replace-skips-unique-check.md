----
description: On the built-in in-memory tables, an insert that replaces an existing row by primary key can give that row a value another row already holds in a column declared unique, leaving two rows sharing it.
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts   # performInsert — PK-conflict REPLACE branch returns before checkUniqueConstraints
repro: verified
severity: wrong-result
reported-from: optimystic (tickets/blocked/quereus-memory-vtab-pk-replace-skips-unique-check)
----

# Memory table: PK-conflict REPLACE skips secondary UNIQUE checks

Reported from the optimystic repository (its own module was fixed; this is the memory reference
module). Reproduced against v4.20.0.

## Repro

```sql
create table T (id integer primary key, v text unique);
insert into T values (1, 'a'), (2, 'b');
insert or replace into T values (1, 'b');   -- succeeds
select * from T order by id;
select * from T where v = 'b';
```

Same with no statement clause when the PK carries its own resolution:

```sql
create table T (id integer primary key on conflict replace, v text unique);
insert into T values (1, 'a'), (2, 'b');
insert into T values (1, 'b');   -- succeeds
```

## Observed

Both shapes: `[{"id":1,"v":"b"},{"id":2,"v":"b"}]`, and the indexed lookup on `v = 'b'` returns both rows.

## Expected

SQLite semantics: REPLACE also resolves the secondary UNIQUE conflict by deleting row 2, leaving
`[{"id":1,"v":"b"}]` (and running the eviction through the normal delete pipeline). For a PK-level
`on conflict replace` with no statement clause, the UNIQUE column's own resolution (default ABORT)
applies — so arguably it should fail with `UNIQUE constraint failed`; settle which against SQLite.

## Where

`performInsert` in `packages/quereus/src/vtab/memory/layer/manager.ts`: when a row exists at the
PK and the resolved action is REPLACE, it calls `recordUpsert` and returns immediately, never
reaching `checkUniqueConstraints` (which already knows how to evict conflicting rows at other PKs
into `evicted` / `evictedRows`). `performUpdate` handles the analogous case by checking UNIQUE when
`uniqueColumnsChanged`. The fix is to run `checkUniqueConstraints` (excluding the replaced PK) in the
REPLACE branch and surface `evictedRows` alongside `replacedRow`.

## TODO
- Pin both shapes in a spec / sqllogic; check the store backend for the same gap.
- Run the UNIQUE check in the PK-REPLACE branch with the correct per-constraint resolution.
- Ensure evicted rows go through change tracking / MV maintenance / FK like other evictions.
