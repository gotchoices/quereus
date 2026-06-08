description: Benchmark harness with trackable results for performance regression detection
files:
  - packages/quereus/bench/run.mjs
  - packages/quereus/bench/suites/parser.bench.mjs
  - packages/quereus/bench/suites/planner.bench.mjs
  - packages/quereus/bench/suites/execution.bench.mjs
  - packages/quereus/bench/suites/mutation.bench.mjs
  - packages/quereus/bench/results/ (.gitignored)
  - packages/quereus/package.json ("bench" script)
  - packages/quereus/README.md (documented in testing section)
----

## What Was Built

Standalone benchmark suite for Quereus, run via `yarn bench`. Measures parser, planner, execution, and mutation throughput across 18 benchmarks.

### Components
- **Runner** (`bench/run.mjs`): Discovers `*.bench.mjs` suites, runs warmup + timed iterations, computes median/p95/min/max, writes timestamped JSON results. `--baseline <file>` prints delta table with color-coded regressions (>20%) and exits non-zero.
- **Parser suite** (4 benchmarks): simple-select, complex-select, wide-select-50cols, insert-values
- **Planner suite** (4 benchmarks): simple-scan-plan, join-plan, aggregate-plan, subquery-plan
- **Execution suite** (6 benchmarks): full-scan-10k, filtered-scan-index-10k, group-by-10k, order-by-10k, join-1kx1k, correlated-subquery
- **Mutation suite** (4 benchmarks): bulk-insert-10k, single-row-insert-1k, update-where-1k, delete-where-100

## Review Notes
- Build passes, 277 tests pass (1 pre-existing failure unrelated)
- All 18 benchmarks run and produce valid results
- Baseline comparison verified with color-coded output
- Removed dead `collect()` helper from mutation.bench.mjs
- Added benchmark suite documentation to README.md testing section
- `bench/results/` properly gitignored

## Usage
```sh
cd packages/quereus
yarn bench                                      # run all, write JSON
yarn bench --baseline bench/results/prev.json   # compare against baseline
```
