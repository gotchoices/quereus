description: Asking for "select distinct" reads the whole table, while the equivalent "group by" is answered from a materialized view, so the same question can cost several times more depending on how it was spelled.
files:
  - packages/quereus/src/planner/nodes/distinct-node.ts
  - packages/quereus/src/planner/rules/distinct/
tradeoffs: Results are already correct and rewriting to group by is an easy workaround, and a rewrite has to preserve how DISTINCT treats NULLs and collations and must not disturb plans that use DISTINCT's own streaming.
----

Reported in GitHub issue #37, where the reporter measured 340 ms against 150 ms on IndexedDB. The plan shape reproduces on the v4.25.0 memory backend: `select distinct period from e where ent = 1` scans `e`, and `select period from e where ent = 1 group by period` scans the materialized view grouped by `ent, acct, period`.

Expected: with no aggregates present, both spellings reach materialized-view substitution. The issue's separate point about walking an index for distinct values is `feat-distinct-from-ordered-access`.
