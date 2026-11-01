description: Cardinality feedback (the planner remembering exact table sizes it sees while running queries) is now on by default, after measuring that it costs nothing noticeable and finding no test or benchmark whose plan changed.
prereq: cardinality-feedback-commit-scoped-publication, cardinality-feedback-replan, cardinality-feedback-diagnostics
architecture: docs/progressive-optimizer.md#38-overhead-budget-and-how-it-is-verified
files: packages/quereus/src/core/database.ts, docs/usage.md, docs/progressive-optimizer.md, docs/sql-txn.md
difficulty: easy
----

# Review: `cardinality_feedback` on by default

Last of the `cardinality-feedback-*` chain. The option's `defaultValue` flips `false` → `true` in `Database` (`src/core/database.ts`, option registration next to `auto_analyze`). No other engine code changed — no earlier ticket needed a fix.

## Overhead gate (flip alone)

Built at HEAD with the default `false`, ran `node bench/run.mjs --filter execution`, flipped, rebuilt, re-ran with `--baseline` on that JSON, back to back on one machine.

| Row (in-memory / `@store-mem`) | Delta | Noise | Verdict |
|---|---|---|---|
| full-scan-10k | +3.1% / +0.7% | ±14.2% / ±8.3% | no change |
| filtered-scan-index-10k | +9.7% / −0.1% | ±23.2% / ±6.1% | no change |
| join-1kx1k | −11.8% / −9.7% | ±45.7% / ±30.2% | unstable in baseline, not gated |
| correlated-subquery | +1.3% / −1.2% | ±17.9% / ±13.2% | no change |
| hand-batched-peer-count | −1.7% / +0.4% | ±20.8% / ±11.6% | no change |

Whole suite: 27 no change, 1 improved (`distinct-text-10k@store-mem` −11.0% vs ±10.1%, noise), 0 regressed, 2 unstable (`join-1kx1k` pair), 15 LevelDB rows skipped (opt-in). Work counters: 30 identical, 0 changed. Logs: `tickets/.logs/cf-on-default.bench-before.log`, `cf-on-default.bench-after.log` (pruned by the runner in time).

## Plan churn: none

- `yarn test` (quereus): 10836 passing, 25 pending — same count as the diagnostics ticket recorded. No assertion changed.
- `yarn test:store`: 10828 passing, 33 pending.
- `yarn test:fork-strict` 10816 / `test:context-strict` 10839 / `test:repr-strict` 10845 passing, all 0 failing.
- Every other workspace's `test` (store, isolation, sync, sync-client, coordinator, plugins, CLI, …) plus `yarn test:scripts`: all passing.
- `yarn bench:gate`: 56 match, 0 differ, all four ratio guards ok. No `bench:accept` was needed, so `bench/reference/*.json` are untouched.
- `yarn lint` (quereus) exit 0; `yarn docs:check` OK.

Why nothing moved: every SQL benchmark table holds at most 10,000 rows, and against the 1000-row default estimate `spread(10000, 1000) = 10001/1001 ≈ 9.99 < 10`, so those tables are recorded but never shift a plan (the 20k/200k rows in `store.bench.mjs` are raw key-value reads with no SQL). The sqllogic corpus tops out at 200 rows (below the 1000-row record floor). No spec that asserts a plan shape scans a ≥ 10,010-row never-analyzed table first.

Sanity check that the default path actually works with no pragma: a fresh `Database`, 20,000 rows inserted, one full scan, then `select * from cardinality_feedback()` returned `observed_rows 20000, baseline_rows 20000, observations 1, shifts 1`.

## Docs

- `docs/usage.md`: option row default `true`; adds the 1000-row floor / 10× re-plan rule and the reproducible-plans escape hatch (`pragma cardinality_feedback = false` before running anything).
- `docs/progressive-optimizer.md`: status note (section 3 complete and on by default); §3.7 determinism (on by default, when it actually varies plans, who should turn it off); §3.7 benchmark gate (the flip changed no reference, and why); §3.8 verification (the measured flip result).
- `docs/sql-txn.md` §9.5: "on (the default)".

## For the reviewer

- **Tests added: none.** The flip is a constant; a test pinning a default value fails the testing bar. Existing feedback specs (`test/optimizer/cardinality-feedback.spec.ts`, `test/runtime/cardinality-observations.spec.ts`) still set `pragma cardinality_feedback = true` explicitly — left in place deliberately so those specs don't depend on the default; now redundant, harmless.
- **Store-pass log noise:** `yarn test:store` prints `[TransactionCoordinator] release/rollback-to savepoint depth … out of range` warnings. Not investigated against HEAD; they are logged warnings, not failures, and come from the store transaction path this ticket does not touch — worth a glance if you have not seen them before.
- **Gap:** the benchmark workloads never cross the shift threshold, so the gate exercises feedback's recording cost (one map write per completed qualifying scan, one publication per execution) but not its re-plan cost. §3.8 already states re-plan cost is bounded by the cooldown rather than benchmarked (one extra compile per shift per statement). Covering a shifting workload in the suite would be a new benchmark, out of scope here.
- **LevelDB-backed bench rows** (`@store-leveldb`) are opt-in and were skipped in both runs, as in every default bench run.
