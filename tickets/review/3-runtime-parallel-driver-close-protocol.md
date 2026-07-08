description: The parallel query driver's shutdown was hardened so it waits for each data source's in-flight work to finish before declaring it closed, instead of walking away while that work is still running.
files: packages/quereus/src/runtime/parallel-driver.ts, packages/quereus/test/runtime/parallel-driver.spec.ts, packages/quereus/test/util/controllable-source.ts
difficulty: medium
----
## What this ticket asked for

`ParallelDriver.closeAll()` closes its per-branch source iterators when the
driver shuts down (a branch errored, the consumer broke early, or the abort
signal fired). The ticket flagged that it calls `it.return()` on a source while
a `next()` call on that same source may still be pending — which native async
generators handle safely (they queue the `return()` behind the in-flight
`next()`), but arbitrary vtab `AsyncIterator` implementations are not obligated
to. The requested fix: settle each source's pending pull *before* calling
`return()`, and add a mock-`AsyncIterator` test asserting `return()` is never
called while its `next()` is unresolved.

## What was actually implemented — and why it diverges from the literal ask

**The ticket's literal prescription (await the pending pull, then `return()`)
cannot be implemented without regressing the driver and deadlocking. I
implemented a different, safe fix and am flagging the divergence loudly so the
reviewer can adjudicate.** Reasoning, so you can check it:

1. **The driver's contract is prompt `return()`-close of in-flight branches.**
   Its own doc comment (`parallel-driver.ts` ~lines 110-118): "the original error
   is re-raised after every other in-flight iterator has been **best-effort
   `return()`-closed**." When one branch errors, the *point* is to stop the other
   branches *now*, not wait for their current `next()` to finish.

2. **`await pending; then return()` deadlocks.** A sibling branch parked
   mid-`next()` (e.g. blocked on input) only unblocks when you signal it via
   `return()`. If `closeAll` awaits that pending `next()` *before* calling
   `return()`, and the `next()` only settles *in response to* `return()`, nothing
   ever resolves. The two existing cancellation tests both hold siblings parked
   on purpose and rely on `return()` interrupting them — they would hang.

3. **This is the established codebase pattern.** The sibling parallel primitive
   `src/runtime/emit/fanout-lookup-join.ts` (its `cleanup`, ~lines 490-515) does
   the *identical* thing: `it.return()` on live branch iterators concurrently
   with their pending pulls, then `Promise.allSettled`. Making `parallel-driver`
   await-before-return would make it inconsistent with its sibling and with the
   real cooperative-cancellation model (branches self-settle a pending `next()`
   at the next row boundary via `throwIfAborted` — see `core/statement.ts`
   `_iterateWithSignal` and `emit/dml-executor.ts`).

**The real defect I did fix:** the old `closeAll` awaited only the `return()`
promises and **discarded the in-flight pulls** (`pendingPulls.clear()` with no
await). So `closeAll` could resolve while a `next()` it started was *still
executing* and possibly still touching cursor/vtab state — cleanup racing ahead
of an outstanding pull. The new code keeps the prompt `return()` signal **and**
awaits each branch's outstanding pull, so the source is fully quiesced before it
is considered closed. See the new module-level `closeBranch()` helper and the
rewritten `closeAll()`.

## Use cases for testing / validation

- **New regression test** (`test/runtime/parallel-driver.spec.ts`, in the
  `drive() — cancellation` block): "drains an in-flight next() before considering
  a source closed (hand-rolled AsyncIterator)". Uses a **hand-rolled**
  `AsyncIterator` (explicitly *not* a native generator) whose `next()` parks
  until the test releases it. It drives two branches, breaks the consumer while
  branch 1's `next()` is parked, and asserts:
  - `closeAll` (the generator's `return()`) does **not** resolve while the parked
    `next()` is still outstanding — the drain guarantee. *This assertion fails on
    the pre-fix code*, which discarded the pull and resolved immediately.
  - `return()` is called exactly once (prompt wind-down signal).
  - after the pull is released, `nextOutstanding` is `false` — the in-flight pull
    drained before close resolved.
- **Existing cancellation tests still pass unchanged** (sibling-error close,
  early-break close, pre-aborted signal) — they exercise the prompt-`return()`
  path this fix preserves.
- **Sibling / integration suites** run green (no regression):
  `test/optimizer/parallel-*.spec.ts`, `test/runtime/eager-prefetch.spec.ts`,
  `test/exec-eval-abort-signal.spec.ts` — 152 passing, 2 pending (unrelated
  strict-fork skips).

Commands run (from `packages/quereus`):
- `node --import ./register.mjs ../../node_modules/mocha/bin/mocha.js "test/runtime/parallel-driver.spec.ts"` → 13 passing
- same runner over `test/optimizer/parallel-*.spec.ts test/runtime/eager-prefetch.spec.ts test/exec-eval-abort-signal.spec.ts` → 152 passing, 2 pending
- `yarn typecheck` and `yarn typecheck:test` → clean
- `npx eslint src/runtime/parallel-driver.ts test/runtime/parallel-driver.spec.ts` → clean

## Known gaps / where to look hard (reviewer: treat as a floor)

- **Adjudicate the divergence above.** If the team genuinely wants strict "never
  call `return()` while a `next()` is outstanding" conformance, that is a
  *cross-cutting cooperative-cancellation redesign*, not a one-file change: the
  driver would need to own an abort controller, thread a combined signal into
  `fork()`/the branch contexts, have sources self-settle their `next()` on abort
  (real vtab leaves already do via `throwIfAborted`; the `controllableSource`
  test helper does **not** — it settles only via `return()`), then await the now-
  settling pulls before `return()`. That would also mean rewriting the two
  parked-sibling cancellation tests to cancel via signal rather than
  `return()`-interrupt. If desired, that should be a new `fix/` or `plan/` ticket
  — it is out of scope for this one-file ticket and I did not open it, leaving the
  call to review.
- **New hang risk (tripwire, parked in code).** Awaiting the outstanding pull
  assumes `return()` causes that pull to settle — true for native generators and
  any source honoring cancellation. A source that *both* ignores `return()` and
  parks its `next()` forever would now **hang** cleanup instead of leaking a
  runaway pull. That is arguably the more correct (loud) failure for a
  contract-violating source, but it is a behavior change from the old
  discard-and-move-on. Recorded as a `NOTE:` in the `closeBranch()` doc comment
  in `parallel-driver.ts` (grep `NOTE:` there).
- **`controllableSource` unchanged.** I did not touch the test helper; the new
  test uses its own inline hand-rolled iterator so the helper's `return()`-
  interrupt model stays intact for the existing tests.
- No new tests for the abort-signal-fired close path specifically (it shares the
  same `closeAll` code path as error/early-break, all covered), and the new test
  exercises only the early-break trigger — the drain logic is trigger-agnostic
  but a reviewer wanting belt-and-suspenders could add an error-triggered variant.
