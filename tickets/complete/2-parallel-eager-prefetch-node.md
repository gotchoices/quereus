description: EagerPrefetchNode — physical pass-through that forks the runtime context on emit and pumps its child sub-tree into a bounded ring buffer immediately. First downstream consumer of `ParallelDriver.fork()`. Manual-construction only; no optimizer wrap-rule yet.
files: packages/quereus/src/planner/nodes/plan-node-type.ts, packages/quereus/src/planner/nodes/eager-prefetch-node.ts, packages/quereus/src/runtime/emit/eager-prefetch.ts, packages/quereus/src/runtime/parallel-driver.ts, packages/quereus/src/runtime/register.ts, packages/quereus/test/runtime/eager-prefetch.spec.ts, docs/runtime.md, docs/architecture.md
----

Adds a new physical relational node `EagerPrefetchNode` and emitter `emitEagerPrefetch` — the first runtime consumer of `ParallelDriver.fork()`. The emitter forks the runtime context once on first iteration, spawns a detached pump that drains the child sub-tree into a bounded ring buffer (default 64), and serves the consumer from that buffer. Rows, attribute IDs, ordering, keys, FDs, equiv classes, monotonicity pass through verbatim; only `deterministic`/`idempotent`/`readonly` propagate via the default child-merge. No optimizer wrap-rule yet — node is reachable only via explicit construction.

A `BoundedPrefetchBuffer<T>` helper backs the emitter: single-producer/single-consumer promise-based ring buffer with await-able `push`/`shift`/`close`/`fail`, one nullable `spaceWaiter` + one nullable `itemWaiter`, abort-aware push. `parallel-driver.ts` re-exports `bumpParentForkCounter` / `dropParentForkCounter` so manual `fork()` consumers don't reach into the internal `strict-fork.ts` module.

## Review findings

### What was checked

- The full implement-stage diff (commit 599308c3): plan-node, emitter, parallel-driver re-export, register.ts, plan-node-type.ts, docs/runtime.md, docs/architecture.md, and the 14-/16-test spec (`packages/quereus/test/runtime/eager-prefetch.spec.ts`).
- Cross-checked against `CacheNode` (the structural sibling) — same withChildren pattern, same `computePhysical` posture, same `emitCallFromPlan` wiring.
- Verified `ParallelDriver.fork` semantics, strict-fork bookkeeping helpers, and the equivalent driver-internal usage at `parallel-driver.ts:154-155` to confirm the manual emitter mirrors it correctly.
- Validator: confirmed `EagerPrefetch` is not in `logicalOnlyTypes` (`plan-validator.ts:185-189`), and `Cache` — its structural analog — is also absent, so the node passes `validatePhysicalTree` by virtue of the default child-merge.
- Lint: `cd packages/quereus && yarn lint` → exit 0, clean.
- Unit tests: `yarn test` (run from `packages/quereus`) → **3327 passing, 6 pending, 0 failures**.
- Strict-fork tests: `yarn test:fork-strict --grep 'EagerPrefetch'` → **16 passing** (includes the two strict-fork cases that skip under default mode).
- Reviewed the honest-gap list from the implementer; verified each claim independently.

### Findings (minor — verified, all left as-is, with reason)

- **`void pump;` (`eager-prefetch.ts:146`) is dead clutter.** The IIFE is already invoked and stored in `const pump`; the discard expression has no effect — the comment "Detach; awaited in finally" is misleading because awaiting is what we want, not detaching. Harmless, but a future reader will wonder. Not patching — keeping the diff small for an ergonomic-only nit.

- **Strict-fork counter bumps happen outside the try/finally** (`eager-prefetch.ts:123-124`). If anything between the bumps and the `try` block at line 148 threw synchronously, the parent counters would stay incremented and subsequent (legitimate) parent mutations would falsely fail with `strict-fork:` violations. In practice this is unreachable: the only realistic synchronous-throw site is `new BoundedPrefetchBuffer(bufferSize)` if `bufferSize < 1`, and `EagerPrefetchNode` defaults `bufferSize` to 64 and offers no other entry point that lets bad input reach `prefetchAsyncIterable`. `driver.fork(rctx, 1)` cannot throw because `1` is in-range, and `sourceCallback(forkCtx)[Symbol.asyncIterator]()` doesn't run the generator body synchronously. Strict-fork is a Node-only test harness (the helpers are no-ops in production), so the failure mode is purely theoretical inside a test that constructs an invalid buffer size directly against `prefetchAsyncIterable`. Not patching — restructuring would force `let`-with-conditional-cleanup that obscures the cleanup order for a corner case no caller can reach.

- **AbortSignal listener accumulation in `BoundedPrefetchBuffer.push`.** Each iteration of the `while (full)` loop adds a fresh `{ once: true }` abort listener that auto-removes only on abort, so a long-lived signal with many full→drain cycles accumulates dormant listeners. Inside `prefetchAsyncIterable` the `AbortController` is local to one call and GC'd with the generator, so the accumulated listeners are bounded by "times push waited" within a single prefetch run — not a leak across runs. If anyone reuses `BoundedPrefetchBuffer` against a long-lived external signal, this becomes a real growth. Not patching — the class is only used internally and the docstring scopes it to "single producer + single consumer per buffer instance."

- **`pump.catch(() => undefined)` in cleanup silently swallows any error the pump throws during shutdown.** The pump's own `try/catch` already routes errors to `buf.fail`; the outer swallow only catches an exception inside `buf.fail` itself (which doesn't throw — it only sets flags). So the swallow is defensive and never fires in practice. Worth flagging if `buf.fail` ever gains throwing behavior.

- **`ParallelDriver` instance is allocated per `emitEagerPrefetch` call** rather than module-scoped. `ParallelDriver.fork` is stateless, so a single instance would work fine; the implementer already noted this in the honest gaps. Cost is one allocation per emitted instruction (not per row), so the impact is nil. Not patching — matches local-construction style of sibling emitters.

- **No `validatePhysicalTree` test for a tree containing `EagerPrefetchNode`.** The validator's blocklist excludes only `Aggregate`/`Retrieve`, so the node passes by inspection; the 3327-test run includes plenty of tree validation paths and none regressed. The implementer's honest gap #7 already calls this out; a 3-line addition to `validation.spec.ts` would close the belt-and-braces gap but it's not load-bearing today.

### Findings (no major; no new tickets filed)

- No correctness defects, no leaks reachable from production code, no API-shape concerns.
- Honest-gap items #1–#7 from the implementer were verified and stand as filed — none of them rise to "major":
  - back-pressure invariant is `bufferSize + 2` not `bufferSize` (test measures `produced - consumed` end-to-end, which is the property the ticket actually cares about);
  - eager-start test is flag-based instead of timer-based (correct given Windows `setTimeout` granularity);
  - `computePhysical` deliberately not overridden (matches `CacheNode`, deferred to the optimizer-wrap-rule ticket);
  - no optimizer wrap-rule yet (parked as `parallel-eager-prefetch-wrap-rule`);
  - no fill-rate telemetry (deferred to `InstructionRuntimeStats` work).

### Spec coverage assessment

Tests cover: pass-through equivalence, empty source, eager start (synchronous body trigger + observable pre-fetch with consumer paused), bounded back-pressure under an infinite-ish fast source, consumer break invokes child `return()`, no-unhandled-rejection, inner-throw identity preservation, consumer-error-path cancellation, both strict-fork interactions (parent-mutation-while-live throws; post-drain mutation OK), no-work-without-consumption (lazy generator semantics), and `BoundedPrefetchBuffer` internal sanity (capacity validation, drain-after-close, fail identity, done-after-close).

Not covered (and not required for this stage): steady-state fast-producer + fast-consumer interleaving (not load-bearing — the bounded back-pressure test already proves the only critical invariant), `EagerPrefetchNode.withChildren` arity/type errors (trivial pattern mirrored from `CacheNode` which is also untested at unit-level), end-to-end SQL with `EagerPrefetchNode` in the tree (requires an optimizer rule that the next ticket adds).

### Docs

`docs/runtime.md` § "EagerPrefetchNode (first ParallelDriver.fork consumer)" and `docs/architecture.md` bullet under the optimizer/runtime overview both accurately describe the new node, including the strict-fork bookkeeping contract and the re-export pattern. Both were updated in the implement commit and reflect the shipped behavior.

### Disposition

Implementation is solid. Lint clean; all 3327 (+16 strict-fork) tests pass. The honest-gap list is accurate and complete. No major findings, all minor findings deliberately left unpatched with explicit reasons above. No new fix/plan/backlog tickets filed by this review pass.
