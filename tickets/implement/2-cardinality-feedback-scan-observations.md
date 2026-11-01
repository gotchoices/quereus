description: When a query happens to read every row of a table, count them and hand the total to the planner's memory of table sizes — behind a database option that stays off by default until the feature is complete and measured.
prereq: cardinality-feedback-row-count-seam
architecture: docs/progressive-optimizer.md#31-what-is-observed
files: packages/quereus/src/runtime/emit/scan.ts, packages/quereus/src/runtime/cardinality-observations.ts (new), packages/quereus/src/runtime/types.ts, packages/quereus/src/runtime/parallel-driver.ts, packages/quereus/src/core/statement.ts, packages/quereus/src/core/database.ts, packages/quereus/src/core/database-cardinality-feedback.ts, packages/quereus/test/runtime/fork-contract.spec.ts, packages/quereus/test/runtime/cardinality-observations.spec.ts (new), docs/progressive-optimizer.md, docs/runtime-parallel.md
difficulty: medium
----
<!-- resume-note -->
RESUME: A prior agent run on this ticket did not complete.
  Prior run: 2026-11-01T01:16:16.639Z (agent: claude)
  Log file: C:\projects\quereus\tickets\.logs\2-cardinality-feedback-scan-observations.implement.2026-11-01T01-16-16-639Z.log
Read the log to see what was done. Resume where it left off.
If the prior run hit a timeout or repeated error, be cautious not to rush into the same situation.
Gardener note: the first run (log `...implement.2026-10-31T23-16-24-940Z.log`) finished the code (committed in the timeout commit); new specs, lint, `yarn test` and `test:fork-strict` were all green, and the post-change execution benchmark showed 0 regressed rows with the five scan-heavy rows "no change" (a uniform +1–10% drift across nearly every row, likely machine state). It then hung running an interleaved HEAD/change A/B benchmark in a scratch worktree — that run exceeds the runner's 10-minute idle limit. Do NOT repeat the A/B run or any benchmark that runs >5 min in the foreground. Re-verify quickly (build, new specs, lint, `yarn test`), record the benchmark result and the drift observation in the review handoff (the `cardinality-feedback-on-by-default` ticket owns the definitive overhead measurement), and advance to review.
<!-- /resume-note -->

# Observe complete table enumerations at the scan leaf

Second of the `cardinality-feedback-*` chain (design: `docs/progressive-optimizer.md` §3.1, §3.5, §3.8). `cardinality-feedback-row-count-seam` built the overlay and its `record()` policy; this ticket feeds it from execution.

## Why not the existing work counters

`runtime_metrics` already counts rows per instruction and per table (`runtime/work-counters.ts`), but metrics mode wraps every streaming output in a counting generator and reads the clock around every instruction — `docs/benchmarking.md` says turning it on corrupts timings — and its structural addresses carry no table identity and no "did this scan finish" fact. Feedback needs a near-free, always-available count of one specific thing, so it gets its own minimal path, independent of `runtime_metrics`.

## Design

### What qualifies (decided once, at emit time, in `emitSeqScan`)

A scan site observes its table only when all hold:

- `plan` is a `SeqScanNode` or `IndexScanNode` — never an `IndexSeekNode`;
- `plan.filterInfo.constraints` is empty and `limit` / `offset` are unset, and the emitter was called without a `filterInfoOverride` (the `OrdinalSlice` limit/offset pushdown);
- `plan.filterInfo.accessPath` is `{ kind: 'fullScan' }`, or `kind: 'index'` with `index.role === 'primary'` and `plan === 'scan'`. Exclude secondary-index walks (a partial index enumerates only the rows its predicate admits), `unresolvedIndex`, and a missing `accessPath` (hand-built `FilterInfo`).

In the flagship shape — `select m.x, b.w from mid m join big b on b.id = m.big_id where m.x = 1` with `big` un-analyzed — the qualifying scan is `INDEX SCAN big USING _primary_` feeding the hash join.

### Counting (per invocation of the scan generator)

- Read the sink once per invocation: `const sink = observesWholeTable ? runtimeCtx.cardinalityObservations : undefined`.
- Count rows in a generator-local variable inside the existing `for await` loop. Budget: **at most one local increment per row** — no property read, no allocation, no extra `await`, nothing that could perturb the cancellation checkpoint or `REPR_STRICT` placement.
- Record only on **natural exhaustion**: the `sink?.observe(schema, rows)` call goes immediately after the `for await` loop, inside the `try`, never in `finally`. An early `return()` (LIMIT above, `Statement.get()`, `EXISTS`/semi-join early exit), an abort, or an error never reaches it.
- `schema` is the emitted `plan.source.tableSchema` object; the overlay's identity check (`record()` ignores a superseded schema) takes care of a plan emitted before a schema swap.

### The per-execution sink (`runtime/cardinality-observations.ts`, new)

`class CardinalityObservations` — `observe(table: TableSchema, rows: number)` stores the last count per lowercased `<schema>.<table>` (re-scans of a nested-loop inner and the two sites of a self-join collapse to one entry); `entries()` and `isEmpty` for the publisher.

- New `RuntimeContext` field `cardinalityObservations?: CardinalityObservations`, documented like `workCounters`. Fork policy **`shared-sink`**: forked branches (`EagerPrefetch`, `AsyncGather`, `FanOutLookupJoin`) report into the parent's sink by reference. Add it to `EXPECTED_FORK_POLICY` in `test/runtime/fork-contract.spec.ts` (tsc forces this via `satisfies Record<keyof RuntimeContext, ForkPolicy>`) and pass it through in `ParallelDriver`'s fork (`runtime/parallel-driver.ts`, beside `workCounters`).

### Option and run sites

- Register database option `cardinality_feedback` in `core/database.ts` (`type: 'boolean'`, `defaultValue: false` — `cardinality-feedback-on-by-default` flips it after measurement). `onChange` to `false` calls `this._cardinalityFeedback.clear()`, so later compiles are catalog-only again.
- `Statement._iterateRowsRawInternal`: when the option is on, create one sink per execution and put it on the `RuntimeContext`; in the existing `finally`, after scan connections are disconnected, publish it (see below) when non-empty.
- `Database._executeSingleStatement` (the `db.exec` path): same.
- The internal run sites (deferred constraints, assertions, materialized-view apply, `ANALYZE`'s own scan) create no sink — they are not instrumented, exactly as they carry no work counters.
- Publishing is bookkeeping and must never fail the statement: wrap it, log at warn on error, continue.

### Publishing (`CardinalityFeedbackManager.publish(sink, { readCommitted })`)

An observation counts the rows its scan could see, which inside a transaction includes uncommitted writes. In this ticket:

- `readCommitted` executions (the mutex-free committed-read path) apply immediately — they read committed state by construction;
- an execution that ends with no transaction open (`getAutocommit()` true) applies immediately;
- otherwise the observations are **discarded** (debug log). This includes every writing statement in autocommit mode, whose implicit transaction is still open when the run site's `finally` runs. `cardinality-feedback-commit-scoped-publication` replaces the discard with hold-until-commit.

Applying = `record(table, rows)` per entry (the floor, shift and LRU policy already live there).

## Edge cases & interactions

- **Early termination** (LIMIT above the scan, `get()`, `EXISTS`, semi-join early exit) records nothing — code after the loop never runs on `return()`. Verify: test (LIMIT); the rest by inspection, same code path.
- **Abort / error mid-scan** records nothing. Verify: inspection (the observe call is not in `finally`).
- **Constrained, seek, pushed-limit and secondary-index access** never observe. Verify: test (a primary-key point seek); inspection for the range-seek, override and secondary-index arms.
- **Nested-loop inner re-scans and self-joins** observe the same table repeatedly; the last count wins. Verify: inspection.
- **Forked parallel branches** share the parent's sink. Verify: the fork-contract policy test plus `yarn test:fork-strict`.
- **Writing statements and explicit transactions** discard their observations in this ticket. Verify: test (inside `begin … commit`, nothing is recorded).
- **Concurrent committed reads** publish immediately even while a writer holds a transaction. Verify: inspection.
- **Option toggling** takes effect at the next execution — the gate is the sink's presence at run time, not an emit-time decision, so cached emission contexts need no recompile; turning it off clears the overlay. Verify: inspection; test that with the option off nothing is recorded.
- **Remote / high-latency modules**: the count is whatever the module yields for an unconstrained `query()`, which is the table as the module defines it. Verify: inspection.
- **Independence from `runtime_metrics`**: both can be on; neither reads the other. Verify: inspection.
- **Publication failure** never fails the user's statement. Verify: inspection (try/catch + warn log).
- **Overhead.** Verify: measurement (TODO below) — no gated regression; scan-heavy rows inside their noise floor.

## Tests (only these)

`packages/quereus/test/runtime/cardinality-observations.spec.ts`, each with `pragma auto_analyze = false` and `pragma cardinality_feedback = true` set before loading a 20,000-row never-analyzed table:

- `select * from big` drained → the overlay (`db._cardinalityFeedback.snapshot()`) holds `big` with 20,000 rows.
- `select * from big limit 10` drained → no entry.
- `select * from big where id = 5` (a primary-key point seek) → no entry.
- `begin; select * from big; commit;` → no entry (discarded in this ticket; the next ticket rewrites this case).
- With `pragma cardinality_feedback = false`, a full scan records nothing.

## TODO

- Before editing: `yarn build`, then `node bench/run.mjs --filter execution` from `packages/quereus`; keep the result JSON path from `bench/results/` as the baseline. (Do not stash or check out to get a baseline — measure the untouched tree first.)
- `runtime/cardinality-observations.ts`: the sink.
- `RuntimeContext.cardinalityObservations` (+ doc comment), fork policy entry, `ParallelDriver` pass-through.
- `emitSeqScan`: emit-time eligibility, per-row local count, post-loop observe.
- Register the `cardinality_feedback` option (default false, clear on disable).
- Sink creation + guarded publish in `Statement._iterateRowsRawInternal` and `Database._executeSingleStatement`.
- `CardinalityFeedbackManager.publish` with the immediate/discard rules.
- Tests above.
- After implementing: `yarn build`, `node bench/run.mjs --filter execution --baseline <baseline json>`; no gated regression, and `full-scan-10k`, `filtered-scan-index-10k`, `join-1kx1k`, `correlated-subquery`, `hand-batched-peer-count` inside their noise floor (see `docs/benchmarking.md` § Measuring one commit's cost). Put the comparison table in the review handoff. `yarn bench:gate` must pass unchanged (the option is off).
- `docs/runtime-parallel.md`: add the field to the fork-policy table (beside `workCounters`); `docs/progressive-optimizer.md` §3.1/§3.5/§3.8: present tense, note the in-transaction discard as interim.
- `yarn lint`, `yarn test`, `yarn test:fork-strict`.
