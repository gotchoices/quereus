description: The parallel query driver's shutdown was hardened so it waits for each data source's in-flight work to finish before declaring it closed, instead of walking away while that work is still running.
files: packages/quereus/src/runtime/parallel-driver.ts, packages/quereus/test/runtime/parallel-driver.spec.ts, docs/runtime.md
difficulty: medium
----
## What shipped

`ParallelDriver.drive()` closes its per-branch source iterators when the driver
shuts down (a branch errored, the consumer broke early, or an abort signal
fired). The old `closeAll` awaited only the `return()` promises and **discarded**
each branch's in-flight pull (`pendingPulls.clear()` with no await), so cleanup
could resolve while a `next()` the driver started was still executing and
possibly still touching cursor/vtab state.

The fix adds a module-level `closeBranch()` helper and rewires `closeAll()` to,
for every still-live branch: signal wind-down promptly via `return()` **and**
await that branch's outstanding pull. The source is fully quiesced before it is
considered closed, without regressing the prompt-`return()` cancellation the two
existing parked-sibling tests rely on.

## Review findings

**Scope of review.** Read the implement diff (commit `f7165837`) fresh, then the
full `parallel-driver.ts`, the `controllable-source.ts` test helper, and the
sibling primitive `emit/fanout-lookup-join.ts`. Traced every `closeAll` entry
path (branch-error, consumer early-break, signal abort, normal completion) and
the yield-suspension corner. Ran the driver spec, the sibling parallel/prefetch/
abort suites, and lint.

**Aspect sweep** — correctness, DRY, resource cleanup, error handling, type
safety, deadlock risk, docs.

- **Divergence adjudication (the implementer's headline flag) — AGREE, no
  action.** The ticket's literal prescription ("await the pending pull, *then*
  `return()`") deadlocks any cooperative source whose parked `next()` only
  settles *in response to* `return()` — the signal never arrives. The implemented
  order (return() first, then await the pull) is the correct one and matches the
  established sibling `fanout-lookup-join.ts` cleanup. The strict "never call
  `return()` while a `next()` is outstanding" conformance the ticket floated is a
  cross-cutting cooperative-cancellation redesign (driver-owned abort controller
  threaded into forks, sources self-settling on abort, rewriting the two parked-
  sibling tests to cancel via signal); genuinely out of scope for a one-file
  change, and correctly **not** opened as a ticket — it would be speculative work
  with no current consumer demanding it.
- **Error-path close correctness — verified sound.** On a branch error the
  errored iterator is not nulled and its pull is already deleted, so `closeAll`
  calls `closeBranch(it, undefined)` on it → a bare `return()` on an already-
  finished iterator (safe for native generators and the `controllableSource`
  helper, neither rethrows). Sibling branches still carry a pending pull and are
  drained. No double-throw, no leaked pull.
- **Yield-suspension corner — verified sound.** If `return()` lands while the
  generator is suspended at `yield` (before the branch reschedules its pull), the
  branch is state `'pulling'` with **no** pending pull; `closeBranch(it,
  undefined)` just closes it. Correct — the delivered row's pull already
  resolved, nothing to drain.
- **Type safety / error handling — clean.** No `any`; pull promise typed
  `Promise<BranchPullResult<T>> | undefined`. `schedulePull` never lets a pull
  reject (it wraps errors into `hadError`), and `closeBranch` still `.catch()`es
  both the `return()` and the pull defensively, so one bad close cannot abort the
  others (`Promise.allSettled`).
- **Doc gap — FIXED inline (minor).** `docs/runtime.md` (~line 1415) described
  `drive()`'s close as best-effort `return()`-close only; it now states the close
  is prompt **and** drained (each live branch's outstanding pull is awaited) and
  points at the `closeBranch` `NOTE:` for the contract-violating-source hang.
- **Tripwire (conditional) — correctly parked, no ticket.** Awaiting the
  outstanding pull assumes `return()` causes it to settle. A source that *both*
  ignores `return()` *and* parks its `next()` forever now **hangs** cleanup
  instead of leaking a runaway pull — arguably the more correct loud failure, but
  a behavior change from the old discard-and-move-on. Recorded as a `NOTE:` in the
  `closeBranch()` doc comment (grep `NOTE:` in `parallel-driver.ts`) and now also
  as a sentence in `docs/runtime.md`. Genuinely conditional ("fine now; only bites
  if a source violates the cancellation contract") → tripwire, not a ticket.
- **Test coverage gap (minor, accepted — no new test).** The new regression test
  exercises the **early-break** trigger only. An error-triggered variant was
  considered and deliberately not added: the drain guarantee lives entirely in the
  shared `closeAll → closeBranch` path, which is trigger-agnostic — the *errored*
  branch is never drained (only its siblings are, exactly as in early-break), so an
  error-triggered test would exercise no new drain logic. The existing
  "cancels remaining branches and rejects with the original error" test already
  proves siblings are `return()`-closed on the error path. Marginal value, not
  worth the added flakiness surface. Recorded here, not filed.

**No major findings** — no new `fix/`, `plan/`, or `backlog/` tickets. The
implementation is correct, consistent with its sibling primitive, and the
divergence from the literal ask is the right call.

## Validation run

From repo root (`node --import ./packages/quereus/register.mjs mocha …`):
- `test/runtime/parallel-driver.spec.ts` → **13 passing**.
- `test/optimizer/parallel-*.spec.ts test/runtime/eager-prefetch.spec.ts
  test/exec-eval-abort-signal.spec.ts` → **152 passing, 2 pending** (the 2 pending
  are pre-existing unrelated strict-fork skips in `eager-prefetch.spec.ts`).
- `npx eslint src/runtime/parallel-driver.ts test/runtime/parallel-driver.spec.ts`
  → clean (exit 0).

Only additional edit this pass: the `docs/runtime.md` close-semantics sentence.
Source and test code from the implement stage are unchanged, so the implement
stage's `yarn typecheck` / `typecheck:test` results still hold.
