description: On the in-memory backend, a query that filters on the first column of a compound index and asks for values greater than some number on a following column declared descending returns no rows, even though matching rows exist.
architecture: docs/memory-table.md
files:
  - packages/quereus/src/vtab/memory/layer/scan-layer.ts
  - packages/quereus/test/logic/05.1.1-secondary-index-range-scan.sqllogic
  - packages/quereus/test/logic/05.1-composite-pk-range-scan.sqllogic
  - docs/memory-table.md
repro: verified
----

A prefix-range scan is a query with equality on the leading columns of a compound key and a range on the next column, such as `k = 'a' and r > 1` over `(k, r desc)`. On the memory backend it loses rows when that next column is declared `desc`, in both the primary key and secondary index branches of `scanLayerResolved`.

## Reproduction

Run with a temporary sqllogic file on the memory backend and on the store backend (`QUEREUS_TEST_STORE=true`):

```sql
create table t (id integer primary key, k text, r integer);
create index ix on t (k, r desc);
insert into t values (1, 'a', 1), (2, 'a', 2), (3, 'a', 3), (4, 'b', 9), (5, '0', 9);

select id from t where k = 'a' and r > 1 order by id;  -- memory: no rows; expected 2, 3
```

The memory run stopped at this first assertion, so the other wrong results in the original report (`r > 1 and r < 3`, `r >= 2`, and `primary key (k, r desc)`) were not re-run at the unfixed code in this stage. They were reported when the ticket was filed, and the file under *Tests* passes in full with the prototype.

The store backend passes the whole file unfixed, so this bug is specific to the memory backend. `buildIndexRangeBounds` in `packages/quereus-store/src/common/store-table-scan.ts` already swaps its bounds by the bounded column's direction.

## Cause

Confirmed by a temporary prototype, since reverted. In the prefix path, `compositeStart` always appends `plan.lowerBound`, whatever the bound column's direction. Over a `desc` column larger values sort first, so rows above the lower bound sit before that start key and the walk begins after them.

The non-prefix path already chooses correctly with `seekFromUpper = isAscending === isDescFirstColumn`. It does not carry over to prefix plans for two reasons: that flag reads column 0, while a prefix plan's bound applies to the column at position `plan.equalityPrefix.length`, and the prefix path never consults the flag.

## Fix

The direction that matters is that of the column the bound applies to, at position `plan.equalityPrefix?.length ?? 0`. The prefix columns do not affect it, because they are fixed within the walk. Direction comes from `schema.primaryKeyDefinition` in the primary branch and `indexDef.columns` in the secondary branch.

- Compute `seekFromUpper` from that column's direction, in both branches. Rename `isDescFirstColumn` to match, and update the comment above `seekFromUpper`. Plans with no prefix behave as before, since position 0 is the same column.
- In the prefix start key, append `seekFromUpper ? plan.upperBound : plan.lowerBound` when present. Forward walks over an ascending bound column get the same start key as today.
- In the prefix walk, also stop once the bound column passes the bound the walk terminates at, instead of reading to the end of the group. Today prefix walks stop only on a prefix mismatch, and the ticket's expected behaviour asks for both. Compare only the terminating bound: the bound the walk starts from can legitimately reject its first row (an exclusive bound positioned on an exact match), and that must not end the walk.

This termination check is the same logic as the existing leading-column check, which appears in both branches, so extract one helper taking the bound column's value rather than adding two more copies. The prototype used this shape:

```ts
function pastTerminatingBound(value: SqlValue | undefined, plan: ScanPlan, seekFromUpper: boolean, comparators: ResolvedScanComparators): boolean {
	if (value === undefined) return false;
	if (!seekFromUpper && plan.upperBound) {
		const cmp = comparators.bound(value, plan.upperBound.value);
		return cmp > 0 || (cmp === 0 && plan.upperBound.op === IndexConstraintOp.LT);
	}
	if (seekFromUpper && plan.lowerBound) {
		const cmp = comparators.bound(value, plan.lowerBound.value);
		return cmp < 0 || (cmp === 0 && plan.lowerBound.op === IndexConstraintOp.GT);
	}
	return false;
}
```

NULL rows are safe with this check, because the column comparators rank NULL lowest. Over an ascending column, NULLs come first in the group and compare below the upper bound, so the walk does not stop on them. Over a `desc` column they come last and compare below the lower bound, so the walk stops there, and those rows could not match a range anyway.

The prototype changed only the seek and the prefix-walk termination, and did not route the existing leading-column checks through the helper. It passed the file under *Tests* and all of `test/logic.spec.ts` plus `test/vtab/**/*.spec.ts` (856 passing). The full `yarn test` was not run. Early stopping was not measured separately; these tests check results only.

## Out of scope

A reverse walk (`plan.descending`) over a prefix plan stays broken: the start key `[prefix]` sorts before its group, so walking backwards leaves the group at once. No engine path asks for this today, and `feat-reverse-index-walk-for-desc-ordering` already records the hazard. Computing `seekFromUpper` as above is also the right choice for that case, so this fix does not add to that work.

## Tests

Add these to the existing sqllogic files, which also run against the store. The secondary index cases go in `05.1.1-secondary-index-range-scan.sqllogic`, and the primary key cases in `05.1-composite-pk-range-scan.sqllogic`, which works off primary key declarations alone and must not gain a standalone `create index`.

This is the file used to verify the prototype, with expected ids in comments. Trim it to one assertion per behaviour.

```sql
create table t (id integer primary key, k text, r integer);
create index ix on t (k, r desc);
insert into t values (1, 'a', 1), (2, 'a', 2), (3, 'a', 3), (4, 'b', 9), (5, '0', 9);
select id from t where k = 'a' and r > 1 order by id;                -- 2, 3
select id from t where k = 'a' and r >= 2 order by id;               -- 2, 3
select id from t where k = 'a' and r > 1 and r < 3 order by id;      -- 2
select id from t where k = 'a' and r >= 2 and r <= 3 order by id;    -- 2, 3
select id from t where k = 'a' and r < 3 order by id;                -- 1, 2
select id from t where k = 'a' and r <= 3 order by id;               -- 1, 2, 3
select id from t where k = 'a' and r between 2 and 3 order by id;    -- 2, 3
-- params: ["a", 1]
select id from t where k = ? and r > ? order by id;                  -- 2, 3
-- read through a transaction's own writes
begin;
insert into t values (6, 'a', 4);
delete from t where id = 2;
select id from t where k = 'a' and r > 1 order by id;                -- 3, 6
select id from t where k = 'a' and r >= 2 and r < 4 order by id;     -- 3
rollback;

-- primary key
create table p (k text, r integer, primary key (k, r desc));
insert into p values ('a', 1), ('a', 2), ('a', 3), ('b', 9), ('0', 9);
select r from p where k = 'a' and r > 1 order by r;                  -- 2, 3
select r from p where k = 'a' and r >= 2 and r < 3 order by r;       -- 2
select r from p where k = 'a' and r < 3 order by r;                  -- 1, 2

-- a later key column, with several rows sharing the bound value
create table m (id integer primary key, k text, r integer, s integer);
create index mx on m (k, r desc, s);
insert into m values (1,'a',1,1),(2,'a',2,1),(3,'a',2,2),(4,'a',3,1),(5,'b',9,9);
select id from m where k = 'a' and r >= 2 order by id;               -- 2, 3, 4
select id from m where k = 'a' and r <= 2 order by id;               -- 1, 2, 3
select id from m where k = 'a' and r > 1 and r <= 2 order by id;     -- 2, 3

-- two equality columns, one of them desc
create table q (id integer primary key, a integer, b integer, r integer);
create index qx on q (a desc, b, r desc);
insert into q values (1,1,1,1),(2,1,1,2),(3,1,1,3),(4,1,2,9),(5,2,1,9);
select id from q where a = 1 and b = 1 and r > 1 order by id;        -- 2, 3

-- stored NULLs in the range column never match
create table n (id integer primary key, k text, r integer null);
create index nx on n (k, r desc);
insert into n values (1,'a',null),(2,'a',1),(3,'a',2),(4,'a',3),(5,'b',null);
select id from n where k = 'a' and r > 1 order by id;                -- 3, 4
select id from n where k = 'a' and r < 3 order by id;                -- 2, 3

-- a collated range column
create table c (id integer primary key, k text, r text collate nocase);
create index cx on c (k, r desc);
insert into c values (1,'a','A'),(2,'a','b'),(3,'a','C');
select id from c where k = 'a' and r > 'a' order by id;              -- 2, 3
select id from c where k = 'a' and r >= 'B' order by id;             -- 2, 3
```

## TODO

- Add the sqllogic cases above and see them fail on the memory backend
- Compute `seekFromUpper` from the bound column's direction in both branches of `scanLayerResolved`
- Choose the prefix start key's bound with `seekFromUpper`
- Extract the terminating-bound check into one helper and use it for prefix and leading-column walks in both branches
- Add a line on `desc` range columns to the prefix-range bullet in `docs/memory-table.md`
- Run `yarn workspace @quereus/quereus test`, `yarn workspace @quereus/quereus lint`, and the new cases against the store with `yarn workspace @quereus/quereus test:store`
