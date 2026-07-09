description: A running query that hit an error could leave background work it had already kicked off unwatched, which under strict settings crashed the whole process; this fixes that and folds six near-identical scheduler loops into two.
files: packages/quereus/src/runtime/scheduler.ts, packages/quereus/test/runtime-scheduler-error-cleanup.spec.ts, packages/quereus/test/runtime-scheduler-modes.spec.ts, packages/quereus/src/runtime/emit/view-mutation.ts, docs/runtime.md
difficulty: medium
----

## What shipped

Two things, in one pass over `packages/quereus/src/runtime/scheduler.ts`:

1. **The real bug — abandoned promises on throw.** The scheduler linearizes a plan
   tree and feeds each instruction's output into the instruction that consumes it by
   *parking* the output in `instrArgs[destination]` until the destination runs. While a
   query runs async, some parked args are still-pending promises. If an instruction
   throws *before* the destination that would await a parked promise runs, that promise
   was never awaited or handled → unhandled rejection → **process-fatal** under Node's
   default strict rejection policy. Fix: on any throw, the async loop now drains every
   remaining parked promise via `Promise.allSettled` (`sweepAbandonedPromises`), logs
   any that rejected (via the `runtime:metrics` logger — not swallowed), and re-throws
   the **original** error.

2. **The collapse — six loops → two.** The six near-identical dispatch loops
   (`runOptimized`/`runWithTracing`/`runWithMetrics` + their three async twins) are now
   **one synchronous entry loop** (`runSyncLoop`) and **one async continuation loop**
   (`runAsyncLoop`), parameterized by a small per-mode `RunHooks` seam. The sweep lives
   once, in `runAsyncLoop`. `runInstructionWithMetricsAsync` was deleted (see caveat 1).

## How to exercise / validate

- **Regression test** (new): `packages/quereus/test/runtime-scheduler-error-cleanup.spec.ts`.
  Builds a `Scheduler` from three synthetic `Instruction`s — leaf `L` returns a promise
  that rejects on a macrotask, sibling `R` throws synchronously, parent `P` has
  `params:[L,R]` (linearizes `[L,R,P]`). Registers a `process.on('unhandledRejection')`
  collector, runs, waits a macrotask, asserts the surfaced error + **zero** leaked
  rejections.
  - **Confirmed fail-before / pass-after** for the `optimized` and `metrics` cases (on
    `main` both leaked — the collector saw the abandoned `L` promise; after the fix,
    zero).
  - The `tracing` case is a **guard, not a fail-before/pass-after** — see caveat 2.
- **Equivalence**: `runtime-scheduler-modes.spec.ts` (optimized/tracing/metrics produce
  identical rows + `tick()` call counts) still passes.
- **Commands run, all green:**
  - `yarn workspace @quereus/quereus run lint` (eslint + `tsc -p tsconfig.test.json`) — clean.
  - `yarn workspace @quereus/quereus run test` — **6531 passing, 9 pending**.
  - `yarn workspace @quereus/quereus run test:fork-strict` — **6524 passing**, exit 0, no
    process crash.
- **Manual trace/metrics shape check** (the equivalence test does *not* cover trace
  ordering — the ticket flagged this): ran a mixed `select … where … order by` under a
  `CollectingInstructionTracer` and dumped the event sequence. Result: `input` count ==
  `output` count (27/27, i.e. every instruction's input is paired with exactly one
  output), row events present for async iterables, no stray error events, rows correct.
  Metrics rows matched. Scratch spec was deleted after inspection.

## What the reviewer should scrutinize (honest gaps)

These are the judgment calls where your adversarial pass is most valuable. Treat the
tests as a floor.

1. **Metrics async is now deferred, not eager (behavioral consolidation).** Pre-collapse,
   the metrics async loop `await`ed each instruction via `runInstructionWithMetricsAsync`
   (eager). The unified loop instead uses `runInstructionWithMetrics` (returns a
   timing-wrapped promise) and **parks it**, deferring the await to the destination —
   structurally identical to the optimized path. I argued this preserves every *asserted*
   metric (`in`/`out`/`executions` are identical; only `elapsedNs` timing noise differs,
   and it's never asserted). **Verify that reasoning.** One concrete edge I found and
   documented (`docs/runtime.md` § Scheduler Execution Model, `NOTE:`): if the *final*
   instruction returns a bare `Promise` (rare — a SELECT root is an async iterable,
   counted synchronously), its `out` may not be recorded yet when `logAggregateMetrics`
   runs, so the **debug-only** aggregate log could undercount by that one instruction.
   Not observable outside the `runtime:metrics` logger. I judged this acceptable vs.
   re-introducing an eager-await divergence; disagree if you think the debug log must be
   exact.

2. **Tracing cannot abandon a promise — by construction.** The tracing async loop eagerly
   `await`s every promise output (transition included) before tracing it, so a rejecting
   promise always surfaces at its own instruction and is never parked-and-abandoned. So
   the sweep's *real* coverage is **optimized + metrics**; under tracing it runs on throw
   but finds nothing live to drain. That's why the tracing regression case asserts it
   surfaces `L`'s rejection (not `R`'s) and leaks zero — it *guards* that the collapse
   didn't break tracing's eager-await, rather than proving a fixed leak. If you think the
   ticket intended a fail-before/pass-after for tracing too, note it's not achievable with
   the current tracing design.

3. **Sweep scope.** `sweepAbandonedPromises` drains only promises sitting in `instrArgs`.
   Promises being awaited by an in-flight `Promise.all(args)` are already handled (the
   `.all` attaches handlers), and there's no code path that throws between an
   instruction's `run` and parking its output. Confirm no promise can escape the sweep —
   e.g. a promise held only in the local `output`/`args` at the moment of throw.

4. **Test is a synthetic unit repro, not an end-to-end SQL repro.** I could not readily
   construct a *public-API* SQL query that leaks (most query errors surface before a
   sibling promise is left dangling, and topology matters). The regression exercises the
   `Scheduler` directly. A reviewer-built integration repro (real plan tree with a
   parked promise + a throwing sibling) would raise confidence; I judged the unit repro
   sufficient given it fails-before/passes-after on the exact mechanism.

5. **`hasPromise[transitionDestination] = true` is still unconditional**, and tracing's
   `onAsyncOutput` parks the *original* promise for a resolved-scalar (re-defer) while the
   old pending-path parked the resolved value. I reasoned these are equivalent from the
   destination's view (`Promise.all` normalizes a non-promise to itself), and the trace
   event traces the same resolved value either way. Double-check that equivalence.

## Non-code follow-ups done

- Updated a stale doc-comment reference `Scheduler.runAsync` → `Scheduler.runAsyncLoop`
  in `src/runtime/emit/view-mutation.ts` (the six methods were renamed/removed).
- Added the error-unwind sweep + the two-loop/`RunHooks` structure to
  `docs/runtime.md` § Scheduler Execution Model, including the metrics debug-log
  `NOTE:` above.
