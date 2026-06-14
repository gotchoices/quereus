description: A set-op view write (BOTH the `exists`-membership path and the new flag-less predicate-honest path) whose branch/leg body is a multi-source (JOIN) body fails at runtime with the internal error `k.k0_0 isn't a column`, and the static `view_info` / `column_info` surfaces over-claim `is_*=YES`. The per-branch fan lowers the branch op through `propagate`, which (for a join branch) builds its OWN multi-source capture reusing the same `__vmupd_keys` (`MS_UPDATE_KEYS_CTE`) relation name the outer set-op capture injected — the inner generated key column reference (`k.k0_0`) cannot resolve against the outer-injected relation. The shape recognizers admit a join leg by a column-only check (`tryBranchColumnNames` / `isWritableLeafLeg` verify projections are plain/literal but not that the FROM is single-source), so the static surfaces report writable while the dynamic write throws an un-diagnosed internal error.
prereq:
files: packages/quereus/src/planner/mutation/set-op.ts, packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/mutation/propagate.ts, packages/quereus/src/func/builtins/schema.ts, packages/quereus/test/logic/93.6-set-op-flagless-write.sqllogic, packages/quereus/test/logic/93.4-view-mutation.sqllogic
difficulty: hard
----

## Symptom

A set-op view whose branch/leg is a JOIN body decomposes its branch op through `propagate`,
which builds a nested multi-source capture colliding with the outer set-op capture
(`MS_UPDATE_KEYS_CTE` / `__vmupd_keys` is reused, so the inner `k.k0_0` key ref can't resolve).

### Repro — flag-less path

```sql
create table j1 (id integer primary key, x integer, color text null);
create table j2 (id integer primary key, y integer);
insert into j1 values (1,10,'red'),(2,20,'blue');
insert into j2 values (1,100),(2,200);
create view JV as
  select j1.id as id, j1.x as x, 'a' as src from j1 join j2 on j1.id = j2.id where j1.color = 'red'
  union all
  select id, x, 'b' as src from j1 where color = 'blue';
-- view_info('JV') WRONGLY reports YES/YES/YES (over-claim)
delete from JV where src = 'a';   -- QuereusError: k.k0_0 isn't a column   (internal, un-diagnosed)
```

### Repro — pre-existing `exists`-membership path (identical failure)

```sql
create table m1 (id integer primary key, x integer, color text null);
create table m2 (id integer primary key, y integer);
insert into m1 values (1,10,'red'),(2,20,'blue');
insert into m2 values (1,100),(2,200);
create view MV as
  select m1.id as id, m1.x as x from m1 join m2 on m1.id = m2.id
  union exists left as inL, exists right as inR
  select id, x from m1 where color = 'blue';
delete from MV where inL = true;  -- QuereusError: k.k0_0 isn't a column
```

This is a **pre-existing shared-substrate limitation**: the membership path (shipped earlier)
exhibits the same internal error for a join branch. The flag-less ticket
(`set-op-flagless-predicate-honest-writes`) did not introduce it but newly makes it reachable
(its recognizer admits join legs by the same column-only shape check). Both paths are affected,
so a single fix should cover the shared substrate.

## Expected behavior

Two acceptable resolutions — the implementer should pick after research:

1. **Clean reject (smaller).** Tighten the shape gate so a branch/leg whose body is NOT a
   single-source (base-table / single-source-writable) body is rejected with a structured
   `unsupported-set-op` / `no-base-lineage` diagnostic, and the static `view_info` /
   `column_info` surfaces report the conservative all-`NO` row — restoring static/dynamic
   agreement. This must gate BOTH recognizers (`isSetOpBranchWritable` /
   `isSetOpFlaglessWritableBody` and their dynamic builders) so they cannot drift.

2. **Compose the nested capture (larger, unlocks the feature).** Give each nested
   `propagate`-driven capture a distinct relation name / scope so an inner multi-source
   capture does not collide with the outer set-op capture, letting a join-branch set-op write
   actually work.

Either way: the static surface MUST match the dynamic truth (no over-claim), and no internal
un-diagnosed error may leak.

## Notes

- Root cause is the hard-coded single `MS_UPDATE_KEYS_CTE` relation name shared by the outer
  set-op capture and the inner branch's multi-source capture (`multi-source.ts` /
  `view-mutation-builder.ts` key-ref injection).
- Add positive (or clean-reject) coverage for a join branch in BOTH `93.4` (membership) and
  `93.6` (flag-less).
