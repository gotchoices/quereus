description: Giving a table an alias in a query stops the engine from answering "order by ... limit" from an index that fits, so it reads and sorts the whole table instead. Results are correct, but the cost grows with table size for no visible reason.
files:
  - packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts # trySortAbsorbViaIndexOrdering
repro: verified
----

Reported in GitHub issue #32. Reproduced on the v4.25.0 build:

```sql
create table t (k text, r integer, x integer, primary key (k, r));
create index t_r on t (r desc);
select x from t order by r desc limit 1;              -- IndexScan USING t_r
select x from t TV order by TV.r desc limit 1;        -- Sort over Alias over a primary-key scan
```

The reporter's real case is eleven "latest revision" lookups, six of them inside CHECK constraints, so each insert sorted a whole journal twice. Removing the aliases works around it, but they chose to keep the aliases for readability and wait for a fix.

Expected: an alias changes nothing about the access path, and the two queries above plan the same way. The issue suspects the rule's downward walk stops at the Alias node. Check whether the same stop affects other rules that walk through to a table access, since the fix belongs at the class level if so.
