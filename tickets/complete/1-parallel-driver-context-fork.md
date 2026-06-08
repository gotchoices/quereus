description: Added `ParallelDriver` runtime primitive — `fork(rctx, n)` produces N independent `RuntimeContext` views, `drive(factories, forks, opts?)` runs them concurrently with a bounded concurrency cap, `AbortSignal` cancellation, and best-effort `return()`-closure on error or early break. Foundation for the broader `parallel-*` track; no plan-node consumers yet.
files: packages/quereus/src/runtime/parallel-driver.ts, packages/quereus/test/runtime/parallel-driver.spec.ts, docs/runtime.md, docs/architecture.md
----

## Summary

Landed `ParallelDriver` as a standalone runtime primitive with two methods:

- `fork(rctx, n)` — N child `RuntimeContext` views. Each fork gets a fresh `RowContextMap` seeded by replaying parent entries through the public `RowContextMap.set()` API (so the per-attribute index is rebuilt cleanly in the child) and a fresh `new Map(parent.tableContexts)`. `db`, `stmt`, `params`, `enableMetrics`, `tracer`, `activeConnection`, `contextTracker`, and `planStack` are shared by reference.
- `drive(factories, forks, opts?)` — async generator. Each `(ctx) => AsyncIterable<T>` factory is invoked with its paired fork. Yields `{ branch, value }` pairs in arrival order. `opts.concurrency` caps in-flight branches (default = N). `opts.signal` cancels cooperatively. On any branch throw, signal abort, or consumer-side `break`, every other in-flight iterator is best-effort `return()`-closed before the error (if any) propagates.

The primitive is intentionally combinator-agnostic — gather/zip/merge/lookup-join semantics belong to downstream nodes, which will impose their own combinators on top of `{ branch, value }` pairs.

Touched only `parallel-driver.ts` (new), `parallel-driver.spec.ts` (new, 12 tests), `docs/runtime.md` (new subsection), `docs/architecture.md` (one bullet). **Zero pre-existing files mutated** — no emitter, planner, optimizer, scheduler, or context-helper changes were required. The "small surgical refactor" escape hatch in the original plan was not needed.

## Review findings

### What was checked

- **The diff first, cold.** Read `parallel-driver.ts` and `parallel-driver.spec.ts` end-to-end before reading the implement-stage handoff summary.
- **RuntimeContext field set.** Confirmed against `runtime/types.ts:14-32` — every field is enumerated by `fork()`.
- **`tableContexts` mutation surface.** Confirmed `runtime/emit/recursive-cte.ts:106-129` is the canonical set/try/delete pattern; the snapshot-at-fork semantic is correct for parallel-inside-recursive and recursive-inside-parallel composition.
- **`RowContextMap` re-driving.** Verified that `RowContextMap.set()` (`context-helpers.ts:42-49`) rebuilds the `attributeIndex` per-call, so re-driving parent entries through `set()` in the child gives the child a correct index.
- **`activeConnection`.** Grep confirmed all read sites are insert/update emitters and the deferred-constraint queue; none participate in parallel paths today. Concurrency-safety of `activeConnection` is explicitly deferred to `parallel-vtab-concurrency-mode`.
- **`signal` handling.** Traced pre-aborted path, mid-stream abort path, and listener-removal in `finally`. Confirmed `abortPromise` does not leak and `onAbort` is removed cleanly.
- **`closeAll` shape.** Traced cancel-on-error, consumer-break-early, and normal-completion paths. All three converge on the same close-all walk; `return()` rejections are swallowed by design.
- **Test fidelity.** Ran `yarn test:all --grep ParallelDriver` (12 passing in ~340ms locally). Ran the full quereus suite (`3307 passing`). Ran `yarn workspace @quereus/quereus run lint` (exit 0).
- **Consumers across the codebase.** `find_references ParallelDriver` confirms zero non-test references — the primitive truly has no plan-node consumers yet, matching the riskiness assessment's framing.

### Findings — fixed inline

- **Documentation gap on snapshot-at-fork semantics for `tableContexts` / `context`.** `docs/runtime.md` originally said "writes in one fork do not leak to siblings or parent" but did not state the inverse direction: parent mutations made *after* the fork is created are not visible inside the fork. The implement-stage riskiness assessment flagged this verbally; the doc now states it explicitly and requires the caller to treat the parent's `context` and `tableContexts` as immutable for the fork lifetime. Also added an explicit note that shared-by-reference fields (`tracer`, `contextTracker`, `planStack`) carry no concurrency guarantee from the driver.
- **`drive()` silently swallows `throw undefined`.** Original `BranchPullResult` used `error?: unknown` and the main loop guarded `if (error !== undefined)`. A factory that did `throw undefined` would be misclassified as a clean done. Replaced with an explicit `hadError: boolean` discriminator + `error: unknown` field, and the main-loop check is now `if (hadError) throw error;`. Verified: no behavior change for the existing 11 tests; the existing throw-at-row-2 test still routes correctly.
- **Lexicographic `.sort()` in concurrency test.** The "runs branches in parallel by default" test sorted branch indices with the default lexicographic comparator. Survives single-digit N but is a footgun for any future test that bumps N past 9. Switched to `(a, b) => a - b`.
- **Test coverage gap: parent-seeded attribute index.** Existing fork tests use an empty parent `RowContextMap`, so the snapshot-re-driving loop's index-rebuild behavior was never exercised. Added a new test `preserves parent-seeded attributes in every fork, then isolates fork-local overrides` that:
  - seeds the parent with one slot **before** fork,
  - asserts every fork's `attributeIndex` resolves the parent-seeded attribute (proves the snapshot loop rebuilt the index),
  - overrides one fork's descriptor entry and asserts siblings + parent see the original value (proves descriptor-identity is preserved across the snapshot, so fork-local `set` updates the *existing* entry rather than adding a parallel one),
  - closes the fork-local override and asserts the fork's index becomes `undefined` while the parent's stays intact.

### Findings — noted, not actioned (out of this ticket's scope)

These are not bugs in the primitive but design surface that downstream consumers will need to take a stance on. The follow-up plan-stage ticket `1.5-parallel-runtime-fork-test-harness` (already in `implement/`) is the appropriate vehicle for the hardening pass.

- **`planStack`, `contextTracker`, `tracer` shared by reference.** JavaScript is single-threaded, so individual `push`/`pop`/`set` operations are atomic. But interleaving across branches produces a `planStack` that no longer represents any single branch's execution path, a `contextTracker` whose source strings can't disambiguate branches, and a `tracer` whose event stream is interleaved by branch without a branch tag. Documented as "shared by reference" with explicit "no concurrency guarantee". The `1.5` harness ticket plans to pin the policy per field via type-level drift detection, which is the right place to revisit.
- **`signal` not forwarded to factories.** Factories receive only the fork context. A factory doing real async I/O (network read, vtab cursor) has no way to abort *inside* its `.next()` — it learns of cancellation only when its next yield is followed by a `return()` from the driver. For mock-source unit tests this is invisible; for real consumers it may matter. The API can be extended later (e.g. add `opts.signal` to the factory's `(ctx, signal) => ...` shape) without breaking compatibility because `signal` would be a new positional arg or property bag.
- **In-flight `.next()` promises continue after error/abort.** When `drive()` throws or the consumer breaks, `closeAll` calls `return()` on every iterator but does not `await` the pending `.next()` promises — they resolve later and become unreferenced. For native async generators this is correct (per spec, `return()` is queued behind a pending `.next()`). For user-defined async iterables that do not honor `return()` mid-`.next()`, the side effects of the in-flight pull are observable. Not a defect, but a property worth knowing.
- **Wall-clock concurrency tests.** Bands are intentionally wide (75–175ms for a target around 100ms). Local runs land at ~111ms / ~115ms — comfortable. On a contended CI runner, the 50ms tick could stretch past 175ms. Risk is "false-fail this one test on a noisy CI", not "wrong code". If it flakes in CI, raise the upper bound rather than tightening the cap — wall-clock benchmarking belongs in `bench/`, not in mocha.

### Riskiness verdict

The implement-stage riskiness assessment recommended **green** for proceeding with the remaining `parallel-*` tickets. After the adversarial pass I concur. Specifically:

- Context-fork shape works without touching any pre-existing file. The descriptor-identity-preserving snapshot loop is now covered by an explicit test.
- The `tableContexts` snapshot-at-fork semantic is correctly documented and is the right shape for parallel-inside-recursive and recursive-inside-parallel composition. The pathological case (parallel boundary spanning multiple iterations of an outer recursive CTE that mutates the same working-table descriptor) is not a pattern any downstream ticket proposes; defer until a consumer actually needs read-through.
- `activeConnection` correctly inherits by reference; declaring vtab concurrency safety is left to the dedicated follow-up ticket.
- The race / abort / close-all paths are sound. The one swallow-`throw undefined` edge has been fixed inline.

No new tickets needed from this review. The `1.5-parallel-runtime-fork-test-harness` ticket already in `implement/` (added by the user between commits) is the right next step — it formalizes the field-policy contract and adds strict-fork mode, which is precisely the hardening the shared-by-reference observations above call for.

## Validation

```
cd packages/quereus && yarn test:all --grep ParallelDriver   # 12 passing (~340ms)
yarn workspace @quereus/quereus test                         # 3307 passing
yarn workspace @quereus/quereus run lint                      # exit 0
```

## End
