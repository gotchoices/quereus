description: A query that filters with "in (select ...)" and sorts by an indexed column can read the whole table when a few direct lookups followed by a sort would do. Queries using a table alias only started doing this recently; queries without an alias have always done it.
architecture: docs/optimizer-rules.md
files:
  - packages/quereus/src/planner/rules/access/rule-key-set-seek.ts # declines at the orderingLoadBearing check; the NOTE above the imports records the missing re-sort
  - packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts # trySortAbsorbViaIndexOrdering drops the Sort before the subquery becomes a semi join
  - packages/quereus/src/planner/rules/aggregate/rule-minmax-index-boundary.ts # second caller of the same walk; min() shows the same loss
  - packages/quereus/test/optimizer/key-set-seek.spec.ts # "declines when the leaf order absorbed the Sort" pins today's decline
repro: verified
----

Found while reviewing `bug-table-alias-defeats-sort-absorption`. That fix gave aliased tables the plan unaliased tables already had, so this problem now reaches more queries.

## Observed

The problem appears when the sort column has an index that does not match the filter, and the filter is an `in (select ...)` or `exists` subquery.

```sql
create table big (id integer primary key, c integer not null, v integer not null);
create index big_c on big(c);
create index big_v on big(v);
-- big has 2000 rows
create table small (bid integer primary key);
insert into small values (1), (2), (3);

select id from big b where b.id in (select bid from small) order by b.v;
```

Rows read from `big` on the memory backend, measured from the statement's work counters. "Before the alias fix" is the same code with `AliasNode` removed from the walk in `trySortAbsorbViaIndexOrdering`.

| Query | Before the alias fix | Now |
|---|---|---|
| `... from big b where b.id in (select bid from small) order by b.v` | 3 | 2000 |
| `... from big b where b.id in (select bid from small) order by b.v limit 2` | 3 | 1999 |
| `... from big b where b.c in (select bid from small) order by b.v` | 60 | 2000 |
| `... from big b where exists (select 1 from small s where s.bid = b.id) order by b.v` | 3 | 2000 |
| `select min(b.v) from big b where b.id in (select bid from small)` | 3 | 1998 |
| `... from big where id in (select bid from small) order by v` (no alias) | 2000 | 2000 |
| `select min(v) from big where id in (select bid from small)` (no alias) | 1998 | 1998 |

Answers are correct in every case. Only the amount of work differs.

## Cause

`trySortAbsorbViaIndexOrdering` runs while the subquery is still a scalar expression inside a Filter, so the module is told nothing about it and the walk over `big_v` looks free of alternatives. The Sort is dropped and the leaf is marked `orderingLoadBearing`. Decorrelation later turns the subquery into a semi join, and `rule-key-set-seek` declines because a multi-seek on another index would not keep the order the leaf now has to provide. Nothing can put the Sort back, so the plan stays a full index walk with a hash probe.

## Expected

The optimizer should not read the whole table when a small key set can drive the lookups and a Sort can restore the order. An ordered walk should still be available where it is the better plan, for example `limit 1` with a large key set whose matches appear early in the walk. No test or measurement yet says where that boundary lies.

The fix must keep the order correct: `declines when the leaf order absorbed the Sort` in `key-set-seek.spec.ts` currently pins the decline, and an order-preserving replacement would need to update it without losing the check that rows arrive sorted.
