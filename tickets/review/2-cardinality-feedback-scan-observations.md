description: When a query happens to read every row of a table, count them and hand the total to the planner's memory of table sizes — behind a database option that stays off by default until the feature is complete and measured.
prereq: cardinality-feedback-row-count-seam
architecture: docs/progressive-optimizer.md#31-what-is-observed
files: packages/quereus/src/runtime/emit/scan.ts, packages/quereus/src/runtime/cardinality-observations.ts, packages/quereus/src/runtime/types.ts, packages/quereus/src/runtime/parallel-driver.ts, packages/quereus/src/core/statement.ts, packages/quereus/src/core/database.ts, packages/quereus/src/core/database-cardinality-feedback.ts, packages/quereus/test/runtime/fork-contract.spec.ts, packages/quereus/test/runtime/cardinality-observations.spec.ts, packages/quereus/test/optimizer/cardinality-feedback.spec.ts, docs/progressive-optimizer.md, docs/runtime-parallel.md
----
# Observe complete table enumerations at the scan leaf — review handoff

Second of the `cardinality-feedback-*` chain (design: `docs/progressive-optimizer.md` §3.1, §3.5, §3.8). The overlay and its `record()` policy came from `cardinality-feedback-row-count-seam`; this ticket feeds it from execution. Code landed across two runs (first run's work is in commit `fa5cd84cc`, the timeout commit; this run added docs, cleanup, and re-verification).

## What was built

- **Eligibility, at emit time** — `enumeratesWholeTable(plan)` in `runtime/emit/scan.ts`: not an `IndexSeekNode`; no constraints, no `limit`/`offset`; access path `fullScan`, or `index` with `role === 'primary'` and `plan === 'scan'`. Any `filterInfoOverride` (the `OrdinalSlice` pushdown) disqualifies. A missing `accessPath` never qualifies.
- **Counting** — per invocation: one read of `runtimeCtx.cardinalityObservations` (only when the site qualifies), then an unconditional generator-local `rowsYielded++` per row in the existing loop. `observations?.observe(schema, rowsYielded)` sits immediately after the `for await` loop inside the `try` — never in `finally` — so early `return()`, abort and error record nothing.
- **Sink** — `runtime/cardinality-observations.ts`, `class CardinalityObservations` with `observe` / `isEmpty` / `entries`. **Deviation from the ticket:** keyed by the `TableSchema` object, not a lowercased `<schema>.<table>` string. Every scan in one execution comes from one compile, so re-scans and self-join sites share the object and still collapse to one entry (last wins), with no string building per completed scan; the overlay keys by name when it records. Reviewer: confirm no path gives two scan sites of one table in a single execution different `TableSchema` objects (I found none — the remap path `tableNameRemap` is set only by deferred-constraint runs, which create no sink).
- **RuntimeContext field** `cardinalityObservations?` (doc comment beside `workCounters`), fork policy `shared-sink` in `EXPECTED_FORK_POLICY`, passed through in `ParallelDriver.fork`.
- **Option** `cardinality_feedback` (`boolean`, default `false`) in `core/database.ts`; `onChange` to false calls `cardinalityFeedbackManager.clear()`. The gate is the sink's presence at run time, so a toggle needs no recompile.
- **Run sites** — `Statement._iterateRowsRawInternal` and `Database._executeSingleStatement` create a sink via `db._beginCardinalityObservations()` and publish it in their `finally` (after scan connections are disconnected) via `db._publishCardinalityObservations(sink, readCommitted)`, which try/catches and logs at warn. Internal run sites create none.
- **Publish** — `CardinalityFeedbackManager.publish(sink, { readCommitted })`: applies when `readCommitted` or `getAutocommit()`; otherwise discards with a debug log and a `NOTE: interim` comment pointing at `cardinality-feedback-commit-scoped-publication`. New context member `getAutocommit` (the existing overlay spec's hand-built context got `getAutocommit: () => true`).
- **Docs** — `docs/runtime-parallel.md` fork-policy table row; `docs/progressive-optimizer.md` §3.5 gets an "Interim" paragraph (in-transaction and autocommit-write discard, publication timing, warn-on-failure), key-files table updated. §3.1/§3.8 were already present tense from planning and match the code.

## Tests added (`test/runtime/cardinality-observations.spec.ts`)

20,000-row never-analyzed `big`, `auto_analyze = false`, `cardinality_feedback = true`:

- `select * from big` drained → overlay holds 20,000 — the positive path end to end.
- `select * from big limit 10` → no entry — early termination (plan verified to be `LimitOffset` over `IndexScan`, i.e. a real early `return()`, not a pushed limit).
- `select * from big where id = 5` → no entry — `IndexSeek` excluded.
- `begin; select * from big; commit;` → no entry — interim discard (the next ticket rewrites this case).
- option off → no entry.

Fork-contract policy entry added (tsc-enforced). No other tests.

## Validation run

- `yarn build`, `yarn lint` (eslint + test tsc): clean (this run).
- `packages/quereus` `yarn test`: 10828 passing, 25 pending, 0 failing (this run). Full root `yarn test` and `yarn test:fork-strict` (10808 passing) were green on identical source in the first run; only docs changed since.
- `yarn bench:gate`: passed — every gated counter matches, all ratio guards hold (this run).
- `yarn docs:check`: OK.
- Probe (first run, not kept as a test): the `db.exec` path records outside a transaction; a `break` out of iteration records nothing; after one insert, a later `exec` full scan records 20,001.

## Benchmark (feedback off — the shipping default)

`node bench/run.mjs --filter execution --baseline <pre-change run>`, two post-change runs, same machine:

| row | run 1 Δ (noise) | run 2 Δ (noise) | verdict |
|---|---|---|---|
| full-scan-10k | +10.4% (±14.6%) | +11.0% (±14.4%) | no change |
| full-scan-10k@store-mem | +6.5% (±10.9%) | +10.1% (±11.6%) | no change |
| filtered-scan-index-10k | +1.8% (±24.1%) | +4.7% (±21.6%) | no change |
| join-1kx1k | +4.1% (±25.9%) | +8.7% (±29.1%) | no change / unstable |
| correlated-subquery | +2.3% (±15.7%) | +2.3% (±16.1%) | no change |
| hand-batched-peer-count | +2.3% (±17.1%) | +2.4% (±17.4%) | no change |

Totals: run 1 — 26 no change, 4 changed below the gate, 0 regressed; run 2 — 26 no change, 3 below gate, 1 unstable, 0 regressed. Counters 30/30 identical.

**Honest caveat:** nearly every row, including ones that never touch the scan leaf (order-by, group-by text), drifted +1–10% against the baseline, which points at machine state between the baseline and the post-change runs rather than this change — but `full-scan-10k` at +10–11% is the row closest to the gate and is also the row the per-row increment would hit. An interleaved HEAD/change A/B to settle it exceeded the runner's 10-minute idle limit and was abandoned; it is not agent-runnable here. `cardinality-feedback-on-by-default` owns the definitive overhead measurement and should run that A/B (interleaved, out-of-band) before flipping the default.

## Known gaps / for the reviewer

- Publication happens in the run site's `finally` even when the statement threw; observations made before the error are complete scans of committed state (autocommit), so this seemed correct — confirm.
- Writing statements in autocommit mode always discard (implicit transaction still open at publish time) — by design for this ticket.
- Nested-loop re-scan, self-join, secondary-index, range-seek and override arms are verified by inspection only, per the ticket.
- Cleanup: the first run left a scratch git worktree (with a `node_modules` junction into the repo) registered; this run removed the junction first, then the worktree. `git worktree list` now shows only the main tree and the two pre-existing `qbench` trees.
