description: On the in-memory backend, a query that filters on the first column of a compound index and asks for values greater than some number on a following column declared descending returns no rows, even though matching rows exist.
architecture: docs/memory-table.md
files:
  - packages/quereus/src/vtab/memory/layer/scan-layer.ts
  - packages/quereus/test/logic/05.1.1-secondary-index-range-scan.sqllogic
repro: verified
----

Found while comparing query results against a table with no index, during `bug-memory-compound-index-unusable-on-leading-column`. It returns the same wrong result on the commit before that ticket, so that ticket did not cause it.

```sql
create table t (id integer primary key, k text, r integer);
create index ix on t (k, r desc);
insert into t values (1, 'a', 1), (2, 'a', 2), (3, 'a', 3);

select id from t where k = 'a' and r > 1;              -- returns nothing; expected 2 and 3
select id from t where k = 'a' and r > 1 and r < 3;    -- returns nothing; expected 2
select id from t where k = 'a' and r >= 2;             -- returns only 2; expected 2 and 3
select id from t where k = 'a' and r < 3;              -- correct: 2 and 1
```

A primary key does the same: with `primary key (k, r desc)`, `k = 'a' and r > 1` returns nothing and `k = 'a' and r < 3` is correct. So does a bound parameter (`k = ? and r > ?` on the index). All of these were run, with the same results, on the code before `bug-memory-compound-index-unusable-on-leading-column` and on the code with its change.

## Likely cause

Read from the code, not yet confirmed by a fix, though it fits the results above: an inclusive bound keeps its boundary row and loses the rows sorted before it. In both the primary and secondary branches of `scanLayerResolved`, the start of a prefix walk is built as the prefix plus the lower bound:

```ts
const compositeStart = [...plan.equalityPrefix];
if (plan.lowerBound) compositeStart.push(plan.lowerBound.value);
```

That is right when the trailing column is ascending. When it is declared `desc`, larger values sort first, so the rows above the lower bound sit before this start key. The walk begins after them, sees only rows that fail the bound, and ends at the group's end.

The non-prefix path already handles this through `seekFromUpper`, which picks the seek bound by the column's direction. The prefix path has no equivalent for the trailing column.

## Expected behaviour

Results match the same query on a table with no index, for a `desc` trailing column with a lower bound, an upper bound, and both, in the primary key and secondary index branches. The walk should still stop early once it passes the bound or leaves the group.

The store backend was not checked. The new tests belong in the sqllogic files because those also run against it.
