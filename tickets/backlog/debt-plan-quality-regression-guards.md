----
description: The correlated-subquery N+1 gap survived for months because benchmarks record timings without asserting anything and no test checks plan quality; add guards so the next per-row-execution regression trips something.
files: packages/quereus/bench/, packages/quereus/test/plan/, packages/quereus/test/optimizer/, packages/quereus/docs/todo.md
----

# Plan-quality regression guards

## Why (post-mortem of the decorrelation gap)

The correlated scalar-aggregate N+1 (fixed under
`quereus-decorrelate-scalar-agg-subquery-project`) was missed despite three
artifacts touching the exact shape:

- `bench/suites/execution.bench.mjs:109` ran the exact correlated-count query
  — but the bench harness records timings only: no baseline, no ratio
  threshold, no assertion. 100 rows on the memory vtab looked fine.
- `test/optimizer/parallel-fanout.spec.ts` asserted local per-row execution as
  the *desired* outcome ("does NOT cluster on local-only chains").
- The Feb-2026 decorrelation ticket scoped scalars out with a one-line note
  and no follow-up ticket; the deferral fell out of the backlog.

The engine's storage backends can have high per-read latency, so plan *shape*
(scan counts, re-execution) matters more than local wall-clock. Nothing in the
repo asserts shape economy.

## Wanted

- **Scan-count assertions**: an instrumented/counting memory vtab usable from
  tests to assert "table X scanned exactly K times for this query" — the
  direct detector for every N+1-family bug (correlated subqueries, uncached
  NLJ right sides, CTE re-execution, IN-cache defeat — see sibling backlog
  tickets, which each want such a test anyway). Build the harness once here
  or in the first of those tickets, then reuse.
- **Bench ratio guards**: for benchmark pairs that compute the same result two
  ways (declarative vs hand-batched), assert a maximum ratio rather than just
  recording both. Keep thresholds loose (order-of-magnitude) to avoid flakes;
  the 26× regression class is what must trip, not 1.3× noise.
- **Deferral hygiene**: sweep `docs/todo.md` (e.g. the stale generic "Subquery
  Optimization" entry at line 11 and the Phase-4 ApplyNode framing) against
  the now-real decorrelation work; retire or re-point entries. Out-of-scope
  notes in tickets must become backlog tickets at review time — the tess rules
  already say this; the sweep catches pre-rule debt.
