----
description: A recursive WITH-clause query used twice in the same statement (for example joined to itself) never finishes and errors out with an iteration-limit message instead of returning rows.
files: packages/quereus/src/runtime/emit/recursive-cte.ts, packages/quereus/src/runtime/emit/cte-reference.ts, packages/quereus/test/plan/cte-materialization.spec.ts
difficulty: medium
----

# Recursive CTE referenced twice runs away and hits the iteration limit

## Repro (fails on main before and after shared CTE materialization landed)

```sql
WITH RECURSIVE cnt(x) AS (
	SELECT 1
	UNION ALL
	SELECT x + 1 FROM cnt WHERE x < 3
)
SELECT a.x AS ax, b.x AS bx
FROM cnt a JOIN cnt b ON a.x = b.x
ORDER BY a.x;
```

Expected: three rows `(1,1) (2,2) (3,3)`.
Actual: `QuereusError: Recursive CTE 'cnt' exceeded maximum iteration limit (10000)`
raised from `runtime/emit/recursive-cte.ts` (iteration-limit guard), reached via
`emit/cte-reference.ts` under a join.

Verified pre-existing: the identical query fails the same way at commit
`ee24d8bf` (before the shared-CTE-materialization change), so this is not a
regression from that work.

## What is known

- Each `CTEReferenceNode` emits its own drive of the shared `RecursiveCTENode`,
  so a statement with two references starts the recursive computation twice.
- The recursive evaluation keeps its working table in
  `RuntimeContext.tableContexts`, keyed by the CTE's table descriptor. Both
  drives share one descriptor, so when the join interleaves the two drives
  (one per side), the second drive's working-table writes clobber the first's
  iteration state — the termination condition (empty delta) is never observed
  and the loop runs until the 10000-iteration guard trips.
- Single-reference recursive CTEs work fine (covered by existing tests in
  `test/plan/cte-materialization.spec.ts`).

## Expected behavior

A recursive CTE referenced N times in one statement must produce the same
result set at every reference site (standard SQL semantics). Computing it once
per statement and replaying (analogous to the shared buffer non-recursive CTEs
now use), or isolating each drive's working table so concurrent drives cannot
interfere, are both acceptable — correctness first.

## Test hook

`test/plan/cte-materialization.spec.ts` has a plan-shape test
("never marks a recursive CTE for shared materialization...") with a NOTE
pointing at this ticket; once fixed, extend that test (or add a sibling) to
assert the query's rows.
