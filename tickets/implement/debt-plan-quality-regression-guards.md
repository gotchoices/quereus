----
description: Add tests and a benchmark check that fail loudly if the query optimizer ever regresses to re-running a subquery once per row, so the next "N+1 scan" performance bug is caught automatically instead of slipping through unnoticed.
files: packages/quereus/test/vtab/_counting-memory-module.ts, packages/quereus/test/vtab/scalar-subquery-cache-scan-count.spec.ts, packages/quereus/test/plan/scalar-agg-decorrelation.spec.ts, packages/quereus/bench/run.mjs, packages/quereus/bench/suites/execution.bench.mjs, packages/quereus/docs/todo.md
difficulty: medium
----

# Plan-quality regression guards

## Background (why this ticket exists)

A correlated scalar-aggregate subquery like
`select p.id, (select count(*) from c where c.pid = p.id) from p`
used to re-execute the inner `count(*)` **once per outer row** — an "N+1 scan"
pattern: N outer rows each drive a full scan of `c`. On 100 outer rows over a
10K-row table that is ~26× slower than the decorrelated plan (one grouped
aggregate joined once). It was fixed under the optimizer rule
`scalar-agg-decorrelation`, but the bug lived for months because **nothing in
the repo asserted plan *shape economy*** — how many times a source is scanned:

- The benchmark suite ran the exact query but only *records* timings; no
  assertion, so a regression prints a number and passes.
- The only tests over that shape asserted **plan structure** (that the
  `ScalarSubquery` node is gone), not **runtime scan counts**.

The engine targets storage backends with high per-read latency, so *how many
times a table is scanned* matters far more than local wall-clock on the
in-memory test table. This ticket adds the missing scan-count guard for the
correlated scalar-aggregate shape, plus a benchmark ratio check, plus a docs
sweep.

## What already exists (reuse, do NOT rebuild)

The scan-counting test harness is already built and in use — **reuse it**:

- `packages/quereus/test/vtab/_counting-memory-module.ts` —
  `CountingMemoryModule extends MemoryTableModule`. Instruments every table it
  hands out with `scanCounts` (Map<lowercased table name → number of `query()`
  opens>) and `rowCounts` (rows pulled). Register it under a module name (the
  existing specs use `countmem`) and create tables with `USING countmem()`.
- Four specs already assert scan economy with it: `nested-loop-right-cache-scan-count.spec.ts`,
  `cte-multi-reference-scan-count.spec.ts`, `in-subquery-cache-scan-count.spec.ts`,
  `scalar-subquery-cache-scan-count.spec.ts`. Follow their structure exactly
  (beforeEach registers the module + seeds tables; each test clears
  `scanCounts`, drains a query, asserts `scanCounts.get('<table>')`).

The gap: **none of the four covers the correlated scalar-aggregate
decorrelation shape** — the exact bug from the post-mortem. That is the one
scan-count guard to add.

## Design of the new guard

### 1. Scan-count regression guard for `scalar-agg-decorrelation`

New spec: `packages/quereus/test/vtab/correlated-scalar-agg-scan-count.spec.ts`.

Setup (mirror the existing scan-count specs):

```
db.registerModule('countmem', module)   // module = new CountingMemoryModule()
create table p (id integer primary key, pid_unused ...) using countmem()
create table c (id integer primary key, pid integer null, v integer null) using countmem()
-- p: several outer rows; c: a handful keyed by pid
```

The load-bearing query is the decorrelatable correlated scalar aggregate:

```
select p.id, (select count(*) from c where c.pid = p.id) as n from p
```

Two assertions make this a real regression guard (not just a snapshot):

- **Enabled (default tuning):** after draining the query, `scanCounts.get('c')`
  MUST equal **1** — decorrelation turns the per-row subquery into one grouped
  aggregate over `c`, scanned once regardless of how many `p` rows exist. This
  is the direct N+1 detector: if `scalar-agg-decorrelation` ever stops firing,
  `c` is scanned once per `p` row and this trips.
- **Disabled (toggle the rule off):** re-run with
  `db.optimizer.updateTuning({ ...tuning, disabledRules: new Set(['scalar-agg-decorrelation']) })`
  and assert `scanCounts.get('c')` equals the outer row count of `p` (N). This
  proves the harness actually *observes* the N+1 — a guard that can only ever
  read "1" is not a guard. (See `parallel-fanout.spec.ts` for the
  disabledRules toggle pattern, incl. restoring tuning in a `finally`.)

Also assert result correctness (the `n` values) in both runs so the guard can
never pass by dissolving the query incorrectly. Empty-child case: an outer `p`
row with no matching `c` rows must yield `n = 0`, not NULL — decorrelation uses
a LEFT join + `coalesce`/count semantics; include one such outer row.

Note in a comment that this is the runtime companion to the plan-shape
assertions in `test/plan/scalar-agg-decorrelation.spec.ts` (which assert the
`ScalarSubquery` node is gone); the two guard the same rule from different
angles and both should stay.

### 2. Bench ratio guard (declarative vs hand-batched)

`bench/run.mjs` today only compares against a `--baseline` file (prior run) and
flags median deltas > 20%. It has **no within-run ratio check**, so a single
run of a query that is 26× slower than its hand-written equivalent looks fine.

Add a within-run ratio guard:

- In `bench/suites/execution.bench.mjs`, add a hand-batched twin of the
  existing `correlated-subquery` benchmark that computes the identical result
  via an explicit grouped join — the shape the optimizer *should* produce:

  ```
  -- declarative (relies on scalar-agg-decorrelation):
  select id, val, (select count(*) from bench_t b where b.label = a.label) as peer_count
  from bench_t a where a.id <= 100

  -- hand-batched twin (what a human writes to avoid N+1):
  select a.id, a.val, coalesce(g.cnt, 0) as peer_count
  from bench_t a
  left join (select label, count(*) as cnt from bench_t group by label) g on g.label = a.label
  where a.id <= 100
  ```

- Add a mechanism for a suite to declare ratio guards. Simplest fit: let a
  suite module export `ratioGuards` alongside `benchmarks`, e.g.
  `export const ratioGuards = [{ name: 'correlated-subquery', baseline: 'hand-batched-peer-count', maxRatio: 10 }]`.
  In `run.mjs` `main()`, after `allBenchmarks` is populated, evaluate each
  guard: `median[suite/name] / median[suite/baseline]`; if it exceeds
  `maxRatio`, print a red failure line naming both benchmarks and the observed
  ratio, and `process.exit(1)` (same exit-code contract the baseline-regression
  check already uses).
- Keep `maxRatio` **loose (order-of-magnitude, e.g. 10)**. The purpose is to
  trip the 26×-class regression, not 1.3× local noise. When the optimizer
  decorrelates correctly the two plans are near-identical (ratio ≈ 1); if
  decorrelation breaks, the declarative side goes N+1 and the ratio spikes past
  10. Document this intent in a comment next to `ratioGuards`.

This makes `yarn bench` a shape-economy gate. It is a *secondary* guard —
`yarn bench` is not part of `yarn test`, so the scan-count spec above is the
primary always-on guard; the bench ratio catches the class in the perf harness
where the 26× was originally measured but never asserted.

### 3. Deferral hygiene — docs/todo.md sweep

`packages/quereus/docs/todo.md` carries pre-decorrelation entries that are now
stale or need re-pointing:

- **Line ~11** `📋 Subquery Optimization: Transform correlated subqueries to
  joins` (under "Upcoming Optimizer Work"). The correlated scalar-aggregate
  case now ships (`scalar-agg-decorrelation` + `-aggregate`). Retire the blanket
  entry or narrow it to the *remaining* uncovered shapes (e.g. correlated
  subqueries in WHERE/EXISTS, non-aggregate correlated subqueries) so the TODO
  reflects reality, not solved work.
- **Phase-4 `ApplyNode` framing (lines ~335–351)** states "the nested-loop
  emitter re-executes the right subtree per outer row" as the standing status.
  That is still true for the cases `ApplyNode` targets, but the correlated
  *scalar-aggregate* subquery is no longer among them. Add a one-line note that
  scalar-aggregate correlation is now handled by decorrelation, so the ApplyNode
  proposal is scoped to the still-correlated shapes — don't let a future reader
  think decorrelation is unbuilt.
- Do not rewrite unrelated sections. This is a targeted retire/re-point of the
  two entries the decorrelation work made stale.

## Edge cases & interactions

- **Guard must observe the N+1, not just its absence.** The disabled-rule run
  asserting `scanCounts.get('c') === N` is mandatory — without it a broken
  harness (e.g. `query()` wrapping lost) would silently read 0/1 and the test
  would pass vacuously. Assert N explicitly.
- **Empty-child outer row → 0 not NULL.** Include a `p` row with no matching
  `c`; assert `n = 0` in both enabled and disabled runs (decorrelation's LEFT
  join must not turn count(0) into NULL).
- **Tuning restore.** The disabled-rule branch must restore
  `db.optimizer.tuning` in a `finally` (plans are built lazily on first
  `.next()`, so the query must be fully drained *inside* the disabled window —
  see the comments in `parallel-fanout.spec.ts` about awaiting results before
  the finally runs).
- **Case-folding of table names.** `CountingMemoryModule` keys `scanCounts` by
  **lowercased** table name; assert on the lowercased key (`'c'`, `'p'`).
- **Bench ratio flake floor.** With `maxRatio` at 10 and both plans decorrelated
  (ratio ≈ 1), warm-up variance on the memory vtab must not approach 10×. Keep
  the existing `warmup`/`iterations` counts; if the twin benchmark shows high
  variance, raise its iterations rather than tightening the ratio.
- **Bench guard when a baseline name is missing/typo'd.** If a `ratioGuards`
  entry references a benchmark name not present in `allBenchmarks`, fail with a
  clear message (misconfiguration), not a silent skip or a `NaN` ratio.
- **Do not disable/skip any pre-existing test.** If `yarn test` surfaces an
  unrelated failure, follow the pre-existing-failure protocol in the ticket
  rules (`tickets/.pre-existing-known.md` / `.pre-existing-error.md`); never
  `.skip` to get green.

## TODO

### Phase 1 — Scan-count guard (primary)
- Add `packages/quereus/test/vtab/correlated-scalar-agg-scan-count.spec.ts`
  reusing `CountingMemoryModule` (`USING countmem()`), following the four
  existing scan-count specs.
- Assert enabled → `scanCounts.get('c') === 1`; disabled (`scalar-agg-decorrelation`
  in `disabledRules`) → `scanCounts.get('c') === N`; result values correct in
  both; include the empty-child (`n = 0`) row.
- Run `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/scancount.log; tail -n 40 /tmp/scancount.log`.

### Phase 2 — Bench ratio guard (secondary)
- Add the hand-batched twin benchmark to `bench/suites/execution.bench.mjs`.
- Add `ratioGuards` export support to that suite and evaluate it in
  `bench/run.mjs main()` (fail + `exit(1)` on breach; clear error on unknown
  baseline name). Loose `maxRatio` (~10) with an intent comment.
- Smoke it: `yarn workspace @quereus/quereus bench 2>&1 | tee /tmp/bench.log; tail -n 40 /tmp/bench.log`
  — confirm the guard line prints and passes at ratio ≈ 1.

### Phase 3 — Docs sweep
- Retire/narrow the stale `Subquery Optimization` TODO entry (~line 11) and add
  the scalar-aggregate-decorrelation note to the Phase-4 `ApplyNode` framing in
  `docs/todo.md`.

### Phase 4 — Validate
- `yarn workspace @quereus/quereus lint 2>&1 | tee /tmp/lint.log; tail -n 40 /tmp/lint.log`
  (lint type-checks spec files — catches signature drift in the new spec).
- Confirm full `yarn test` green.
