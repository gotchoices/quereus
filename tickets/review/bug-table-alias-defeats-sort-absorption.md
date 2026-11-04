description: Giving a table an alias in a query used to stop the engine from answering "order by ... limit" (and min/max) from an index that fits, so it read and sorted the whole table. Aliased queries now use the same index as unaliased ones.
architecture: docs/optimizer-rules.md
files:
  - packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts # the fix: trySortAbsorbViaIndexOrdering walk admits AliasNode, plus comment updates
  - packages/quereus/src/planner/rules/aggregate/rule-minmax-index-boundary.ts # header comment only; second caller of the walk
  - packages/quereus/test/optimizer/desc-index-ordering.spec.ts # new reproduction test
  - packages/quereus/test/optimizer/minmax-index-boundary.spec.ts # derived-table test moved from "declines" to "fires"
  - docs/optimizer-retrieve.md # describes the walk
  - docs/optimizer-rules.md # ruleMinMaxIndexBoundary entry
repro: verified
----

Reported in GitHub issue #32. **A human needs to reply on the issue once this lands**; the fix has not been committed yet, so no reply has been posted.

## What changed

`trySortAbsorbViaIndexOrdering` walks down from a Sort to the table's Retrieve node and returns null at any node it does not admit. A table alias builds an `AliasNode` directly above the Retrieve, so the walk stopped there, the Sort stayed, and the access-path rule picked the primary key. `AliasNode` is now admitted alongside `ProjectNode` and `FilterNode`. An Alias only changes `relationName` and keeps attribute ids, so sort keys still resolve through `tableRef.getAttributeIndex()`. The rebuild loop needed no change.

`rule-minmax-index-boundary` calls the same walk, so aliased tables and derived tables now also get boundary reads for `min`/`max`.

```sql
create table t (k text, r integer, x integer, primary key (k, r));
create index t_r on t (r desc);
select x from t TV order by TV.r desc limit 1;
-- before: Sort over INDEX SCAN t USING _primary_
-- after:  ALIAS tv over INDEX SCAN t USING t_r ORDER BY 1 DESC, with no Sort
```

## Tests

- `desc-index-ordering.spec.ts`, "plans an aliased table exactly like the unaliased one, apart from the Alias": the ticket's two queries have the same plan once Alias rows are dropped, neither has a Sort, and the aliased query returns the right row. Fails without the fix.
- `minmax-index-boundary.spec.ts`, "a derived table between the aggregate and the table": moved to the "fires" group. Asserts a LIMITOFFSET in the plan, answer 120, one row scanned, and all 12 scanned with the rule disabled. Fails without the fix.

## Validation

- `yarn workspace @quereus/quereus test`: 10966 passing, 25 pending, 0 failing.
- `yarn test:store`: 10959 passing, 32 pending, 0 failing.
- `yarn lint`: exit 0.

I also ran about 35 queries with and without the fix on the memory backend, in a throwaway script that is not checked in, and compared rows and plans. Rows were identical for every query, and every plan difference was a Sort removed or a boundary read added. They covered:

- nullable `min`/`max` through an alias and through a derived table, including the case where a NULL must not be returned
- nullable `order by` in both directions, confirming NULLs still come first and the Sort stays where the index would put them last
- a filter inside a derived table, plus `limit`, `distinct` and computed columns inside a derived table, which still decline
- aliased views, opposite inner and outer orderings, `limit` with `offset`, and `exists`
- correlated "latest revision" subqueries, and joins
- `join lateral`; the comma form `from t o, lateral (...)` is a parse error both with and without the fix, so only `join lateral` was compared

A `check` constraint with an aliased latest-revision subquery, the reporter's use case, accepted and rejected the right rows with the fix.

## Points for the reviewer

- **Aliased subquery in a join gets no seek (verified, left as the ticket asked).** With a 2000-row `big`, `join (select * from big order by v) z on z.id = s.bid` gets an index-nested-loop seek on the primary key, while `join (select * from big b order by b.v) z ...` does not, because the absorb path sets `orderingLoadBearing`. This is not a regression. Measured with and without the fix, the aliased form has the same join shape and scans the same rows (4000 with a 2-row outer table, using a loop join and cache; 2000 with a 4-row outer table, using a hash join), and the fix only removes its Sort. Recorded in the accepted-tradeoff `NOTE:` in `fallbackIndexSupports`.
- **`NOTE:` in `rule-minmax-index-boundary.ts` still holds, so it is unchanged.** The walk only succeeds if it ends at a Retrieve, so an Alias is always over a table. `select min(q.d) from (select d from n) q` over a nullable `d` kept its `is not null` filter and returned the real minimum. That filter is what the note's ASC warning depends on.
- **Not checked: store-module plans.** `yarn test:store` shows answers are correct on the store module, but I did not check whether store plans absorb the Sort for aliased tables. The new plan-shape tests run on the memory backend. A user-written `limit` is not passed to the module during this walk (backlog `feat-sort-absorb-blind-to-limit-general`), so the store may still decline on cost, aliased or not.
- **Comment and doc updates:** the walk's node list in `ruleGrowRetrieve`, the `trySortAbsorbViaIndexOrdering` doc comment, the `truncationIsSafe` paragraph (an Alias discards no rows, so its logic is unchanged), a new paragraph in `docs/optimizer-retrieve.md`, and a sentence in the `ruleMinMaxIndexBoundary` docs entry.
- **Separate site, not touched:** the direct-child lookup in `ruleGrowRetrieve` affects only modules implementing `supports()`, and is filed as backlog `bug-table-alias-stops-query-module-growth`.
