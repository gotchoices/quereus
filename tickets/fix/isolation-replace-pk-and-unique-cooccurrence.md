description: In the isolation layer, a single `INSERT OR REPLACE` whose new row both collides on the PRIMARY KEY with an existing underlying row AND collides on a secondary UNIQUE with a DIFFERENT existing row loses the new row's non-PK values — the PK slot reverts to the old underlying row's values instead of taking the new ones. Pre-existing (reproduces before `internal-eviction-reporting`); surfaced during that ticket's review.
prereq:
files: packages/quereus-isolation/src/isolated-table.ts, packages/quereus/test/logic/55-internal-eviction-reporting.sqllogic
----

## Problem

`IsolatedTable.update()` (insert path) is the only substrate that runs **both** a
PK-collision check (`checkMergedPKConflict` → `replacedUnderlyingRow`) and a non-PK
UNIQUE check (`checkMergedUniqueConstraints` → tombstones the conflicting row) for the
same call without short-circuiting between them. (Memory/store INSERT short-circuit on a
PK collision before the secondary-UNIQUE check — a separate gap.) When both fire in one
`INSERT OR REPLACE`, the new row's non-PK column values are lost: the row at the
colliding PK ends up with the **old** underlying values.

This contradicts the `internal-eviction-reporting` handoff note, which asserts
`replacedRow` and `evictedRows` "cannot co-occur in the current memory/store/isolation
substrates." They **can** co-occur in isolation, and the result is wrong.

### Reproduction (store mode = isolation-over-store; confirmed on HEAD and on the parent commit)

```sql
create table b (id integer primary key, email text not null, unique (email));
insert into b values (5, 'old'), (9, 'dup');
-- new row pk=5 collides with b(5,'old') on PK AND with b(9,'dup') on UNIQUE(email):
insert or replace into b values (5, 'dup');
select id, email from b order by id;
-- ACTUAL (yarn test:store):  [{id:5, email:'old'}]      ← new value 'dup' lost; b(9) evicted
-- EXPECTED:                   [{id:5, email:'dup'}]      ← b(5) replaced to 'dup', b(9) evicted
```

A plain PK-collision REPLACE with no secondary conflict works correctly
(`insert or replace into a values (5,'new')` → `(5,'new')`), so the defect is specific
to the **co-occurrence** of the PK-collision replace and the secondary-UNIQUE eviction.

### Pre-existing

Reproduces identically with the `isolated-table.ts` / `store-table.ts` / `manager.ts` /
`dml-executor.ts` / `types.ts` sources checked out at the commit **before**
`internal-eviction-reporting` (`d29d90d2`). The eviction-reporting change did not cause
it and does not alter the stored-data outcome — it only added `evictedRows` reporting
(FK/events/watch) on top of the same tombstone behavior. So this is a latent isolation
merge bug, not a regression.

## Suspected cause (starting point, not verified)

The insert path captures `replacedUnderlyingRow` from `checkMergedPKConflict` (which does
**not** tombstone the PK-colliding underlying row — it relies on the overlay insert
shadowing it, with the same-PK collision becoming an UPDATE at flush). It then runs
`checkMergedUniqueConstraints`, which `insertTombstoneForPK`s the secondary conflict
(pk=9) and inserts a tombstone row into the overlay. The subsequent overlay insert of the
new row (pk=5) then appears not to take effect / not to shadow the underlying row. Trace
the overlay state after the tombstone insert and confirm whether the new-row overlay
upsert is being dropped, mis-keyed, or shadowed by the just-written tombstone, and whether
the overlay's own UNIQUE(email) check (now that a tombstone with NULL email exists) is
interfering. The `getOverlayRow` / merge-read path for pk=5 after the co-occurrence write
is the place to instrument.

## TODO

- Add a failing store-mode test (extend `55-internal-eviction-reporting.sqllogic` with a
  co-occurrence case, or a dedicated isolation spec). Assert both the surviving row's
  new values AND that the secondary conflict was evicted.
- Root-cause and fix the overlay merge so the new row's values win at the colliding PK
  while the secondary conflict is still evicted.
- Confirm FK cascades fire correctly for BOTH the replaced row (old PK image) and the
  evicted row once the data path is correct (the `internal-eviction-reporting` pipeline
  already routes both — this ticket is about the stored-data correctness underneath it).
- Consider whether the memory/store INSERT short-circuit (which skips the secondary-UNIQUE
  check on a PK collision) should be aligned with SQLite as a follow-up; it is a related
  but distinct gap (already noted as out of scope in `internal-eviction-reporting`).
