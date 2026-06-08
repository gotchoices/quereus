description: EagerPrefetch pump now starts on run() (overlaps hash-join build with probe's first fetch); wrap rule gated on concurrencySafe both sides. Reviewed & complete.
prereq:
files: packages/quereus/src/runtime/emit/eager-prefetch.ts, packages/quereus/src/runtime/emit/bloom-join.ts, packages/quereus/src/planner/rules/parallel/rule-eager-prefetch-probe.ts, packages/quereus/src/planner/nodes/eager-prefetch-node.ts, packages/quereus/test/runtime/eager-prefetch.spec.ts, packages/quereus/test/optimizer/parallel-eager-prefetch-probe.spec.ts, docs/runtime.md, docs/optimizer.md
----

## What shipped

`EagerPrefetchNode`'s pump now starts **eagerly on `run()`** (scheduler arg-assembly), not on the consumer's first `.next()`. Inside a `BloomJoinNode` this lets the probe's first fetch overlap the build phase's materialization — the headline latency win. The wrap rule (`rule-eager-prefetch-probe`) is gated on `concurrencySafe === true` for **both** probe and build sides, because the eager pump iterates the probe concurrently with the build's for-await.

Key changes:
- `eager-prefetch.ts` — `prefetchAsyncIterable` is now a plain function that forks + starts the pump at call time and returns a manual `AsyncIterable<Row>` whose iterator owns idempotent teardown via `next()`/`return()`/`throw()`.
- `bloom-join.ts` — acquires the probe iterator up front, moves the build phase inside the `try`, and closes the probe in a `finally` covering both phases (so an eager pump is never leaked, including build-error-before-probe).
- `rule-eager-prefetch-probe.ts` — concurrency gate added after skip predicates, before cost gate; strict `=== true`, mirroring `rule-async-gather-union-all`.
- `eager-prefetch-node.ts` + `docs/runtime.md` + `docs/optimizer.md` — eager-start, iterate-or-close contract, concurrency gate, and strict-fork interaction documented.

## Review findings

### Checked

- **Eager-start mechanism (the headline claim).** Verified against `scheduler.ts` (`runOptimized`/`runAsync`): instructions run in post-order, so `emitEagerPrefetch.run` is invoked during arg-assembly *before* `emitBloomJoin.run`'s generator body. Since `prefetchAsyncIterable` now starts the pump synchronously at call time, the probe pump is in flight before the build's `for await` begins. Overlap is real, not cosmetic. The unit "build/probe overlap" timing test passes (probe first-fetch lands at ~0ms of an 80ms build window).
- **Cleanup / resource teardown.** `cleanup()` is guarded by a `cleanedUp` flag → idempotent; fires on done-path, `return()`, and `throw()`. Aborts pump, closes buffer, calls `childIter.return()`, awaits the (always-resolving) pump, drops fork counters. The pump body catches all errors into `buf.fail`, so `void pump` never produces an unhandled rejection. `bloom-join`'s `finally` calls `leftIter.return?.()` on every exit path; double-cleanup is a no-op. All cleanup paths covered by tests (consumer break, consumer throw, source throw with identity preserved, never-iterated).
- **Concurrency gate correctness.** `concurrencySafe` is a real `PhysicalProperties` field; leaves derive it from `getModuleConcurrencyMode(module) !== 'serial'` (default `'serial'` → false; memory module declares `'reentrant-reads'` → true). The default child-merge ANDs children. Strict `=== true` matches `rule-async-gather-union-all`. Gate semantics (both sides must tolerate concurrent sibling iteration on a shared connection) are sound. Feature is reachable end-to-end (remote vtab with `concurrencyMode !== 'serial'` + non-zero `expectedLatencyMs`), not dead code.
- **Strict-fork "false-positive" judgment.** Confirmed `bumpParentForkCounter`/`dropParentForkCounter` are genuine no-ops when `STRICT_MODE` is off (env-gated `QUEREUS_FORK_STRICT`, off by default). Also confirmed `createRowSlot`'s `rctx.context.set` only throws under the *strict* row-context map — in production it's a plain `Map.set` and cannot throw. So the eager-fork-live-for-statement interaction is strict-harness-only; the skip-under-strict approach (matching the existing Sort-above-AsyncGather pattern) is the correct, lower-risk, ticket-aligned choice. The documented alternative (detach the fork from the parent counter) was not taken — agreed.
- **Non-prefetch (common) path regression.** `bloom-join`'s manual `while (leftIter.next())` is semantically identical to the old `for await`; acquiring `[Symbol.asyncIterator]()` before the build phase does not start a regular generator's body (starts on first `.next()`, still after build). No behavior change for local plans.
- **Docs.** Read both `docs/runtime.md` § EagerPrefetchNode and `docs/optimizer.md` § Eager-prefetch probe against the code; accurate, including the `'reentrant-reads'` literal and pass-placement. The stale "eager-start out of scope" note was removed.
- **Lint + tests.** `yarn workspace @quereus/quereus run lint` clean. Full default suite: **3461 passing, 10 pending, 0 failing**. Targeted eager-prefetch + rule specs: 31 passing, 2 pending (strict-only).

### Minor (observations — not fixed, no production impact)

- **`prefetchAsyncIterable` is single-iteration.** A second `[Symbol.asyncIterator]()` call shares the one buffer/pump/cleanup, so rows would split and the first to finish tears down for both. Same effective contract as an async generator; the sole consumer (`emitBloomJoin`) iterates once. Left as-is.
- **`bloom-join` acquires `leftIter` and creates slots before the `try`.** If those synchronous steps threw they'd skip the `finally` and leak the pump — but `createRowSlot` cannot throw in production (only under the strict row-context map, which is the already-skipped strict path). No production risk; not worth the churn of restructuring the `finally`.
- **Overlap test is wall-clock-based** (`setTimeout`), but the band is generous (`< buildMs/2`) and matches the other parallel timing tests.

### Major (new tickets filed)

- None.

### Test-gap note (acceptable)

- No bloom-join-level integration test drives a real eager-prefetched plan with a *throwing build phase*. The build-error-before-probe cleanup is covered conceptually by the `finally` and by the unit-level cleanup tests; constructing this deterministically at the plan level was judged not worth the cost. Flagging, not blocking.

### Pre-existing failure (already triaged)

- The strict-mode `ruleFanOutLookupJoin … (execution equivalence)` failure the implementer flagged was already resolved by the runner's triage pass (commit `4db5ab07`: added the strict-skip guard to `parallel-fanout.spec.ts`, removed `tickets/.pre-existing-error.md`). Nothing outstanding.

## End
