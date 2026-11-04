description: Giving a table an alias in a query used to stop the engine from answering "order by ... limit" (and min/max) from an index that fits, so it read and sorted the whole table. Aliased queries now use the same index as unaliased ones.
architecture: docs/optimizer-rules.md
files:
  - packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts # the fix: trySortAbsorbViaIndexOrdering walk admits AliasNode, plus comment updates
  - packages/quereus/src/planner/rules/aggregate/rule-minmax-index-boundary.ts # header comment only; second caller of the walk
  - packages/quereus/src/planner/rules/access/rule-key-set-seek.ts # review: NOTE now points at the follow-up ticket
  - packages/quereus/test/optimizer/desc-index-ordering.spec.ts # new reproduction test
  - packages/quereus/test/optimizer/minmax-index-boundary.spec.ts # derived-table test moved from "declines" to "fires"
  - docs/optimizer-retrieve.md # describes the walk
  - docs/optimizer-rules.md # ruleMinMaxIndexBoundary entry
repro: verified
----

Reported in GitHub issue #32. **A human needs to reply on the issue once this lands**; no reply has been posted.

## What changed

`trySortAbsorbViaIndexOrdering` walks down from a Sort to the table's Retrieve node and returns null at any node it does not admit. A table alias builds an `AliasNode` directly above the Retrieve, so the walk stopped there, the Sort stayed, and the access-path rule picked the primary key. `AliasNode` is now admitted alongside `ProjectNode` and `FilterNode`. An Alias only changes `relationName` and keeps attribute ids, so sort keys still resolve through `tableRef.getAttributeIndex()`.

`rule-minmax-index-boundary` calls the same walk, so aliased tables and derived tables now also get boundary reads for `min`/`max`.

```sql
create table t (k text, r integer, x integer, primary key (k, r));
create index t_r on t (r desc);
select x from t TV order by TV.r desc limit 1;
-- before: Sort over INDEX SCAN t USING _primary_
-- after:  ALIAS tv over INDEX SCAN t USING t_r ORDER BY 1 DESC, with no Sort
```

## Known cost

Some aliased queries now read far more rows than before: an `in (select ...)` or `exists` filter combined with an `order by` on an indexed column. They went from a key-set seek plus a Sort to a full index walk (3 rows to 2000 in the measured case). Unaliased queries already behaved this way. Answers are correct. Tracked in `bug-absorbed-sort-blocks-key-set-seek`.

## Tests

- `desc-index-ordering.spec.ts`, "plans an aliased table exactly like the unaliased one, apart from the Alias".
- `minmax-index-boundary.spec.ts`, "a derived table between the aggregate and the table", moved to the "fires" group.

## Review findings

Read the diff of `ticket(implement): bug-table-alias-defeats-sort-absorption` first, then probed the fix with throwaway scripts outside the repository. To compare against the old behaviour, a load hook removed `AliasNode` from the walk at run time, so no source file was changed for it.

**Major, filed: performance regression the handoff missed.** The handoff said every plan difference was a Sort removed or a boundary read added. That is not the whole picture: the absorbed Sort marks the leaf's order as required, and `rule-key-set-seek` then declines. On a 2000-row table, `select id from big b where b.id in (select bid from small) order by b.v` went from 3 rows read to 2000, and `select min(b.v) ...` with the same filter went from 3 to 1998. Unaliased forms read 2000 and 1998 both before and after the fix. The site was already marked by a `NOTE:` in `rule-key-set-seek.ts` as conservative, but nothing measured the cost. Filed as `tickets/fix/bug-absorbed-sort-blocks-key-set-seek.md` and linked from that `NOTE:`. I did not narrow this fix to avoid it, because keeping aliased and unaliased plans different is the bug this ticket removes.

**Minor, fixed in this pass:** only the `NOTE:` update above. No other code or test changed.

**Gap in the handoff, now closed: store-module plans.** Using `StoreModule` over `InMemoryKVStore`, aliased and unaliased queries got the same plan apart from the Alias, in all four pairs compared. `order by r desc`, with and without `limit 1`, keeps its Sort over the primary key in both forms, because the module declines on cost. `max` reads one row in the bare, aliased and derived-table forms. This was an in-memory store only; `yarn test:store` was not re-run, since the only source change in this pass is a comment.

**Checked, no defect:**

- Renamed columns: `select r as k, k as r` in a derived table and in a view sorts by the right underlying column, and `max`/`min` through the view read one row and return the right value.
- Limits inside a derived table, including a numeric `offset` (the form the grow rule can swallow): the Sort or aggregate stays above the LimitOffset, and answers are right.
- Collation: `collate nocase` in a derived table or in the sort key keeps the Sort or the full scan, and the order is right.
- Equality, range, `in` list and `or` filters on another index keep their seek, with the same plan apart from the Alias and the same rows read aliased and unaliased.
- Filter above the Alias: same seek and rows read as the unaliased form.
- Nested derived tables, nullable `max`, and `count(*)` beside `max` (still a full scan).
- Asof rewrite: `lateral-top1-asof` still fires with aliases on either side, including with indexes that can absorb each Sort (`trades(ts)` and `quotes(ts desc)`). The aliased left side now uses `trades_ts` with no Sort, and answers match the old code.
- Ordered `group_concat` over an aliased derived table: order is right.
- `insert`, `delete` and `update` reading the same table through an aliased ordered subquery: same result as unaliased, and the insert did not re-read its own new rows.
- The aliased subquery in a join that gets no seek: the existing accepted-tradeoff `NOTE:` in `fallbackIndexSupports` covers it. I did not re-measure it, and did not re-file it.

**Tests:** both new tests stay. Each fails without the fix according to the handoff, each pins a separate behaviour, and neither mocks anything. No test added or cut. The new ticket carries the reproduction for the regression.

**Docs:** read `docs/optimizer-retrieve.md`, the `ruleMinMaxIndexBoundary` and key-set entries in `docs/optimizer-rules.md`, and the key-set paragraph in `docs/optimizer.md`. They are accurate for the current behaviour. Searched `docs/`, `src/planner` and `test/` for statements that an Alias stops the absorb walk and found none left. The Project-Alias comment in `property-planner.spec.ts` is about a different rule.

**Type safety, resource cleanup, error handling:** nothing to report. The change widens a union type, allocates nothing that needs cleanup, and adds no error path.

**Source hygiene:** `rule-grow-retrieve.ts` is 982 lines (`wc -l`) and is not listed in backlog `debt-oversized-source-files`. This ticket added only a few lines, so no size ticket was filed.

**Tripwires:** none added. The existing `NOTE:` in `rule-minmax-index-boundary.ts` about nullability still holds, because the walk only succeeds when an Alias ends at a Retrieve, so its revisit condition has not tripped.

**Validation in this pass:** `yarn workspace @quereus/quereus test`: 10966 passing, 25 pending, 0 failing. `yarn lint`: exit 0.
