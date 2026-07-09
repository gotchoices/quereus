description: When one step of a running query fails, other background work the query already started is left dangling and never waited on, which can crash the whole process; the fix also collapses six copy-pasted scheduler loops into one.
files: packages/quereus/src/runtime/scheduler.ts, packages/quereus/test/runtime-scheduler-modes.spec.ts
difficulty: medium
----

## Summary

The runtime scheduler (`packages/quereus/src/runtime/scheduler.ts`) linearizes a plan
tree into an instruction array and runs it. Instruction outputs feed later
instructions: an instruction's output is pushed into `instrArgs[destination]`, and
when the destination instruction runs it awaits those args (`Promise.all`). While a
query runs asynchronously, some of those parked args are **still-pending promises**.

**The bug (confirmed).** If an instruction throws *before* the destination that would
have awaited a parked promise runs, that promise is never awaited or handled. It
becomes an unhandled rejection. Under the project's strict harness / Node
`--unhandled-rejections=strict`, an unhandled rejection is **process-fatal** — so an
ordinary query error can escalate into a process crash depending on timing.

### Reproduction (verified)

Topological ordering guarantees `destination > index`, and a parent's two children
linearize as `[L-subtree, R-subtree, P]`. So if `L` returns a promise (parked at `P`)
and its sibling `R` throws, `P` never runs and `L`'s promise is abandoned.

A direct `Scheduler` unit repro was run and **failed as predicted**: the original
error (`R-threw`) still surfaced, *and* the run leaked unhandled rejections
(observed 2) from the abandoned parked promise(s). This confirms the escalation path.

The repro instructions (build a `Scheduler` from three synthetic `Instruction`s — an
async-rejecting leaf `L`, a synchronously-throwing sibling `R`, and a parent `P` with
`params: [L, R]`) belong in the regression test below.

### Where it lives

The parking happens only in the **async** loops — `runAsync`, `runAsyncWithTracing`,
`runAsyncWithMetrics` (scheduler.ts ~lines 171-213, 263-333, 380-426). The three
**sync** entry loops (`runOptimized`, `runWithTracing`, `runWithMetrics`) switch to an
async loop on the first promise they see, so they never hold a promise in `instrArgs`
— they have nothing to sweep. But there are six near-identical dispatch loops total,
and the ticket asks that the sweep (and future fixes) land once.

## Fix design

### 1. Promise sweep on throw (the real bug)

In each async loop, wrap the dispatch body so that when it unwinds due to a throw:

- Iterate every remaining `instrArgs` entry (skip the `undefined` / already-consumed
  slots), collect the entries that are (or contain) promises.
- `await Promise.allSettled(...)` over them so none becomes an unhandled rejection.
  This must include the transition/pending promise parked at `transitionDestination`
  (it lives in `instrArgs`, so sweeping `instrArgs` covers it).
- For any swept promise that itself **rejected**, `log` it (drained, not swallowed
  silently — use the existing `runtime:metrics` logger or a scheduler logger; do not
  eat it quietly per AGENTS.md).
- Re-throw the **original** error — the swept results/rejections must not replace it.

Do NOT sweep on the normal (non-throw) completion path; parked promises are consumed
normally there.

### 2. Collapse the six loops (cleanliness — same pass)

Fold the variants so the sweep lands in one place. A realistic target is **two**
hook-parameterized loops, not literally one, because the sync fast path must stay
synchronous (returning early on the first promise) while the async path awaits:

- one hook-parameterized **sync entry** loop (replaces `runOptimized` /
  `runWithTracing` / `runWithMetrics` bodies), and
- one hook-parameterized **async** loop (replaces the three async twins), where the
  sweep-on-throw lives once.

Parameterize by a small hooks seam, e.g.:

```ts
interface RunHooks {
  onInput?(i: number, instruction: Instruction, args: RuntimeValue[]): void;
  // runs the instruction (metrics variant wraps timing here)
  runInstruction(instruction: Instruction, ctx: RuntimeContext, args: RuntimeValue[]): OutputValue;
  // returns possibly-transformed output (tracing wraps async iterables here); may be async
  onOutput?(i: number, instruction: Instruction, output: OutputValue): OutputValue | Promise<OutputValue>;
  onError?(i: number, instruction: Instruction, error: unknown): void;
}
```

The exact seam shape is the implementer's call — the above is a sketch, not a mandate.

### Behavioral invariants that MUST be preserved (the collapse's traps)

- **Tracing eagerly awaits each async output before tracing it** (current
  `runAsyncWithTracing` lines ~306-313 `await output` then `traceOutput`), so trace
  events are ordered by settlement. Optimized/metrics **defer** awaiting to the
  destination via `Promise.all`. The async loop's `onOutput` hook must therefore be
  allowed to be async and, for tracing, await before emitting — do NOT flatten this
  to eager-await-everywhere (would change metrics/optimized concurrency) nor
  defer-everywhere (would reorder/break trace events). The existing
  `runtime-scheduler-modes.spec.ts` equivalence test guards row output but NOT trace
  ordering — verify trace event count/shape is unchanged by hand.
- **`wrapIterableForTracing`** must still wrap async-iterable outputs (and only in the
  tracing hook), including the initial pending output at `startIndex`, exactly as
  today. Its double-wrap guard (`TRACED_ITERABLE_SYMBOL`) stays.
- **Metrics timing**: `runInstructionWithMetrics` (sync path returns a `.then/.catch`
  timing-wrapped promise) and `runInstructionWithMetricsAsync` behavior must survive
  the move into the `runInstruction` hook. `logAggregateMetrics()` is currently
  called on the **normal completion** path only (not on throw) — preserve that.
- **`countInputs` / `countOutputs`**, `hrtimeNs` timing semantics unchanged.
- Sync loops still return early (synchronously) on the first promise, handing off to
  the async loop with the same `(instrArgs, startIndex, pendingOutput)` — the fast
  path must not become async.

## Validation

- Add the regression test (below) — it must fail before the fix, pass after.
- `runtime-scheduler-modes.spec.ts` must still pass (optimized/tracing/metrics
  behavioral equivalence).
- Run under strict rejection handling to prove no leak escalates. `test-runner.mjs`
  has a `--fork-strict` mode (`yarn test:fork-strict`) — use it to confirm an
  abandoned rejection no longer kills the process.
- `yarn workspace @quereus/quereus run lint` (eslint + tsc on test files).
- `yarn test` (full quereus suite) green.

## TODO

Phase 1 — regression test (write first, watch it fail)
- [ ] Add a spec (extend `test/runtime-scheduler-modes.spec.ts` or a new
  `runtime-scheduler-error-cleanup.spec.ts`) that builds a `Scheduler` from synthetic
  instructions: leaf `L` returning a promise that rejects on next tick, sibling `R`
  throwing synchronously, parent `P` with `params: [L, R]`. Register a
  `process.on('unhandledRejection', ...)` collector, `await scheduler.run(ctx)` in a
  try/catch, wait a macrotask, assert (a) the thrown error is `R`'s, and (b) zero
  unhandled rejections. Confirm it FAILS on current `main`.
- [ ] Add a matching case that exercises the async **tracing** and **metrics** paths
  (set `ctx.tracer` / `ctx.enableMetrics`) so the sweep is covered in all three async
  loops, not just optimized.

Phase 2 — sweep fix
- [ ] Implement the sweep-on-throw helper (drain parked promises via
  `Promise.allSettled`, log rejections, rethrow original) in the async loop.

Phase 3 — collapse
- [ ] Introduce the `RunHooks` seam; collapse the three sync entry loops into one and
  the three async loops into one, with the sweep living once in the async loop.
- [ ] Manually verify trace event output and metrics stats are unchanged
  (count/shape) after the collapse — the existing equivalence test does not cover
  trace ordering or metrics fields.

Phase 4 — validate
- [ ] `yarn workspace @quereus/quereus run lint`
- [ ] `yarn test` (stream with `tee`)
- [ ] `yarn test:fork-strict` to prove no process-fatal rejection escapes.
