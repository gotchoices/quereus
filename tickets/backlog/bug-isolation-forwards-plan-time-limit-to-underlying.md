description: Inside a transaction, a query with a row limit can return too few rows or a wrong answer if the storage module stops reading at that limit, because rows the transaction deleted use up the limit before the isolation layer removes them.
architecture: docs/design-isolation-layer.md
files:
  - packages/quereus-isolation/src/isolation-module.ts    # getBestAccessPlan (~:796) forwards the request, limit included, unchanged
  - packages/quereus-isolation/src/isolated-table.ts      # merged reads remove shadowed rows after the underlying has already stopped
  - packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts   # truncationIsSafe / probeAccessPlan — the licence, which only considers rows a Filter can discard
  - packages/quereus/src/vtab/best-access-plan.ts         # request.limit contract
repro: verified
severity: wrong-result
likelihood: unusual
tradeoffs: No in-tree module stops at the limit (the memory module ignores it and the store uses it for pricing), so this only affects out-of-tree modules such as lamina, and withholding the limit under isolation would cost those modules the LIMIT pushdown they implement it for.
----

Found while working `bug-claimed-null-test-lost-under-isolation-overlay`.

## What happens

`BestAccessPlanRequest.limit` licenses a module to stop producing rows early. The engine grants it only when `truncationIsSafe` proves that nothing between the scan and the LIMIT can discard a row, and that proof looks only at `Filter` nodes in the plan.

`IsolationModule.getBestAccessPlan` forwards the request unchanged, so the underlying module receives the licence. But the isolation merged read can also discard rows the underlying produced: a committed row deleted or updated in the transaction is shadowed by the overlay. If those rows filled the limit, the underlying has already stopped, and the rows that should have replaced them are never read.

## Reproduction

The double is a `MemoryTableModule` subclass that records `request.limit + offset` in `getBestAccessPlan` and stops its next `query()` after that many rows, which is what the licence allows. It runs under `IsolationModule`:

```sql
create table t (id integer primary key, a integer);
insert into t values (1, 1), (2, 2), (3, 3);
begin;
delete from t where id = 1;
select min(id) from t;   -- returns null; expected 2
```

The min/max boundary rewrite sent the limit in this case. `select id from t limit 1 offset 0` and `select id from t order by id limit 1 offset 0` did not reach the module with a limit in the same run and returned the correct row, so the rewrite is the one confirmed route.

An update that moves a committed row out of the query's window should fail the same way, since it shadows the row too. That case was read from the code and not run.

## Expected behaviour

A query inside a transaction returns exactly the rows it would return after commit, whether or not the underlying module stops at a plan-time limit.
