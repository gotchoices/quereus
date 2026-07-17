description: Verify the new automated guards that catch a query-optimizer regression where a subquery gets re-run once per row (an "N+1 scan"), so that class of performance bug can't slip through unnoticed again.
files: packages/quereus/test/vtab/correlated-scalar-agg-scan-count.spec.ts, packages/quereus/test/vtab/_counting-memory-module.ts, packages/quereus/bench/suites/execution.bench.mjs, packages/quereus/bench/run.mjs, docs/todo.md
difficulty: medium

# Review: plan-quality regression guards

## What shipped

Three guards against the "N+1 scan" class of optimizer regression — where a
correlated scalar-aggregate subquery
(`select p.id, (select count(*) from c where c.pid = p.id) from p`) re-scans the
inner table once per outer row instead of decorrelating into one grouped join.
The `scalar-agg-decorrelation` rule fixes the shape; nothing asserted *scan
economy* before this, so the class was invisible to CI.

### 1. Primary always-on guard (in `yarn test`)

`packages/quereus/test/vtab/correlated-scalar-agg-scan-count.spec.ts` — reuses
the existing `CountingMemoryModule` (`USING countmem()`), which counts every
`query()` open keyed by lowercased table name. Two tests over the exact
post-mortem shape:

- **enabled (default tuning):** `scanCounts.get('c') === 1` — decorrelation
  collapses the per-row subquery into one grouped aggregate over `c`.
- **disabled (`disabledRules: {'scalar-agg-decorrelation'}`):**
  `scanCounts.get('c') === N` (N = 4 outer rows) — proves the harness actually
  *observes* the N+1, so the guard can't pass vacuously.
- Both runs assert result correctness, including the empty-child row
  (`p.id = 4` → `n = 0`, not NULL).

### 2. Secondary guard (in `yarn bench`, NOT in `yarn test`)

- `execution.bench.mjs`: added `hand-batched-peer-count` — the explicit
  grouped-join twin of the existing `correlated-subquery` benchmark.
- `execution.bench.mjs`: new `ratioGuards` export
  (`[{ name, baseline, maxRatio }]`).
- `run.mjs`: `checkRatioGuards()` evaluates `median[target]/median[baseline]`
  after the run and `process.exit(1)` on breach or on a misconfigured
  (unknown) benchmark name. `maxRatio` is a loose 10× (order-of-magnitude) — it
  trips the 26×-class regression, not local noise.

### 3. Docs sweep

`docs/todo.md`: narrowed the stale "Subquery Optimization" entry to the
*remaining* uncovered shapes, and added a scalar-aggregate-decorrelation note to
the Phase-4 `ApplyNode` framing so a reader doesn't think decorrelation is
unbuilt.

## Validation performed

- New spec in isolation: **2 passing**.
- `yarn lint` (eslint + `tsc -p tsconfig.test.json`): **EXIT=0** — type-checks
  the new spec's call sites.
- `yarn test` (full suite): **7063 passing, 13 pending, EXIT=0**.
- `node bench/run.mjs` smoke: ratio guard printed and passed at **0.60×**
  (`correlated-subquery` / `hand-batched-peer-count`), EXIT=0. The declarative
  side is actually *faster* than the hand-batched twin — confirms decorrelation
  fires and produces an efficient plan.

## Reviewer: where to look / how to exercise

- **Trip the primary guard yourself:** the disabled-rule test already proves the
  N+1 is observable. To prove the enabled assertion is load-bearing, temporarily
  add `scalar-agg-decorrelation` to a default `disabledRules` and confirm the
  first test fails with `expected 4 to equal 1`.
- **The enabled `=== 1` assertion implicitly guards physical join selection too:**
  the decorrelated plan only scans `c` once if a hash/merge join (not
  nested-loop) is chosen — an NLJ over the grouped aggregate would re-scan `c`
  per outer row. So a regression in *either* the decorrelation rule *or* the
  physical-join choice trips it. That is intended strictness, but worth knowing.
- **Ratio-guard math:** `checkRatioGuards` in `run.mjs` — the degenerate-median
  branch (`base.median_ms > 0 ? … : …`) avoids NaN/Infinity if a median rounds to
  0; the 10K-row workloads never hit that in practice.

## Known gaps / honest limitations (treat tests as a floor)

- **The ratio-guard *failure* path is not covered by an automated test** — only
  the pass path was smoke-run. The `exit(1)`-on-breach and unknown-benchmark
  branches were verified by reading, not by executing. `yarn bench` is not part
  of `yarn test`, so there is no CI that exercises the fail path. If you want
  certainty, set `maxRatio: 0.1` locally and confirm the run prints
  `ratio guard FAILED` and exits non-zero. Deliberately left unautomated (a
  self-failing bench entry would be noise); flagged here rather than filed.
- **Ticket `files:` header path drift:** the ticket named
  `packages/quereus/docs/todo.md`, but the only `todo.md` is at repo root
  `docs/todo.md` — that is the file edited. No `packages/quereus/docs/` exists.
- **Backend coverage:** the scan-count spec is memory-vtab only. It guards a
  plan-shape property (scan count), which is backend-agnostic, so `test:store`
  coverage would add little; not added.
- **N is small (4).** The enabled assertion is exact (`=== 1`) so it catches a
  regression at any N; N=4 only needs to be >1 for the disabled run to
  distinguish 1 from N. Not a snapshot that would need re-baselining.

## Tripwire parked

The bench ratio-guard failure path being unexercised by CI (above) is a
conditional concern, not a latent defect — recorded here in findings and in this
handoff, not filed as a ticket. No single code site warranted a `NOTE:` comment
beyond the intent comment already next to `ratioGuards`.
