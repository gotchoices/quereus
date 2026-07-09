description: A running query that hit an error could leave background work it had already kicked off unwatched, which under strict settings crashed the whole process; this fixes that and folds six near-identical scheduler loops into two.
files: packages/quereus/src/runtime/scheduler.ts, packages/quereus/test/runtime-scheduler-error-cleanup.spec.ts, packages/quereus/test/runtime-scheduler-modes.spec.ts, packages/quereus/src/runtime/emit/view-mutation.ts, docs/runtime.md
----

## What shipped

Two changes in one pass over `packages/quereus/src/runtime/scheduler.ts`:

1. **Bug fix — abandoned promises on throw.** The scheduler linearizes a plan tree
   and feeds each instruction's output into its consumer by *parking* the output in
   `instrArgs[destination]` until the destination runs. While a query runs async,
   some parked args are still-pending promises. If an instruction throws *before*
   the destination that would await a parked promise runs, that promise was never
   awaited or handled → unhandled rejection → process-fatal under Node's strict
   rejection policy. Fix: on any throw the async loop drains every remaining parked
   promise via `Promise.allSettled` (`sweepAbandonedPromises`), logs any that
   rejected (via `runtime:metrics`, not swallowed), and re-throws the original error.

2. **Collapse — six loops → two.** The six near-identical dispatch loops
   (`runOptimized`/`runWithTracing`/`runWithMetrics` + async twins) are now one
   synchronous entry loop (`runSyncLoop`) and one async continuation loop
   (`runAsyncLoop`), parameterized by a per-mode `RunHooks` seam. The sweep lives
   once, in `runAsyncLoop`. `runInstructionWithMetricsAsync` was deleted.

## Review findings

Adversarial pass over commit `270be295`. Read the full scheduler diff and the
current file with fresh eyes before the handoff; scrutinized correctness, DRY,
resource cleanup, error handling, type safety, and test coverage.

**Verified correct (no action):**

- **Sweep completeness.** Every instruction output is either parked in
  `instrArgs[destination]` or returned as the final result — there is no code path
  that throws between an instruction's `run` and parking its output, so no live
  promise can escape the sweep (confirms the implementer's honest-gap #3). Promises
  consumed by an in-flight `Promise.all(args)` already have handlers attached by
  `.all`, and their slot is cleared to `undefined` before the await, so they are
  neither leaked nor double-awaited by the sweep.
- **Metrics counting equivalence.** `in`/`out`/`executions` are incremented
  identically to the pre-collapse eager path (`executions`/`in` at call, `out` on
  settle via the timing wrapper's `.then`). The only divergence is the debug-only
  aggregate-log timing edge the implementer documented as a `NOTE:` tripwire in
  `docs/runtime.md` (§ Scheduler Execution Model): if the *final* instruction
  returns a bare `Promise`, its `out` may not be recorded when `logAggregateMetrics`
  runs. Not observable outside the `runtime:metrics` logger. Left as-is — the
  tripwire is correctly parked at the doc site; re-introducing an eager await to fix
  a debug log would undo the consolidation.
- **Tracing park-value equivalence.** For a resolved-scalar transition/output the
  async hook re-defers the original promise to its destination (`Promise.all`
  normalizes a non-promise to itself), so the destination sees the same resolved
  value as the pre-collapse loop; trace events carry the same resolved value either
  way (confirms honest-gaps #2 and #5).
- **No dangling references** to the six removed private methods anywhere in the
  tree; the only surviving `runOptimized`/`runTracing`/`runMetrics` names are
  unrelated local test closures in `runtime-scheduler-modes.spec.ts`. The stale
  `Scheduler.runAsync` → `runAsyncLoop` doc-comment fix in `view-mutation.ts` is
  correct, and its "siblings run concurrently, prior sibling not awaited" claim
  still holds under the unified loop.

**Fixed inline (minor):**

- **Test-coverage gap — trace event pairing had no durable guard.** The equivalence
  spec (`runtime-scheduler-modes.spec.ts`) asserted only rows + `tick()` call counts
  and `events.length > 0`; the implementer verified input/output pairing by hand
  with a scratch spec that was then deleted, leaving nothing to catch a future break
  of the shared async loop's trace ordering. Added durable assertions to that spec:
  every traced `input` has exactly one matching `output`, input and output events
  cover the same instruction indexes, and there are zero `error` events on the happy
  path. Passes.

**Not filed (judged acceptable):**

- **No end-to-end SQL repro** (implementer honest-gap #4). The regression exercises
  the `Scheduler` directly with three synthetic instructions and is confirmed
  fail-before/pass-after for the `optimized` and `metrics` cases on the exact leak
  mechanism. A public-API SQL query that leaks is hard to construct (most query
  errors surface before a sibling promise dangles, and topology matters) and would
  add little over the mechanism-level repro. Not worth a debt ticket.

**Major findings:** none.
**Tripwires:** none new — the metrics debug-log undercount was already parked as a
`NOTE:` in `docs/runtime.md` by the implementer; re-verified it is accurate and
correctly sited.

## Validation

- `yarn workspace @quereus/quereus run lint` — clean (eslint + `tsc -p
  tsconfig.test.json`), re-run after the test edit.
- `yarn workspace @quereus/quereus run test` — **6531 passing, 9 pending**.
- `yarn workspace @quereus/quereus run test:fork-strict` — **6524 passing**, exit 0,
  no process crash under strict unhandled-rejection.
- Two scheduler specs (`runtime-scheduler-modes`, `runtime-scheduler-error-cleanup`)
  run in isolation with the new pairing assertion — 4 passing.
