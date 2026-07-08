description: The engine used to pause and wait on a background task for every value it computed per row, even though that task had almost always already finished; it now uses finished values directly and only waits when a value is genuinely still pending.
files: packages/quereus/src/runtime/async-util.ts, packages/quereus/src/runtime/emit/filter.ts, packages/quereus/src/runtime/emit/project.ts, packages/quereus/src/runtime/emit/join.ts, packages/quereus/src/runtime/emit/returning.ts, packages/quereus/src/runtime/emit/bloom-join.ts, packages/quereus/src/runtime/emit/merge-join.ts, packages/quereus/src/runtime/emit/window.ts, packages/quereus/src/runtime/emit/constraint-check.ts, packages/quereus/src/runtime/emit/view-mutation.ts
difficulty: medium
----

## What changed

Per-row scalar sub-programs (filter predicate, projected columns, join condition, residual join predicates, window partition/order keys, constraint checks) were evaluated with an unconditional `await subprogram(rctx)`. The sub-scheduler (`Scheduler.run`) runs **synchronously** until it hits an actually-async instruction, so in the common case it returns a concrete value, not a `Promise`. But `await concreteValue` still schedules a microtask (per spec `await x` ≡ `await Promise.resolve(x)`), so an N-row × k-column query paid N×k needless microtask suspensions.

Fix: branch on `value instanceof Promise` at each per-row evaluation site — use the value directly when concrete, `await` only when genuinely pending. Async sub-programs (e.g. a correlated subquery that yields a real promise) still work unchanged; only the synchronous hot path skips the hop.

### Helper

`resolveMaybe<T, R>(value: MaybePromise<T>, fn: (v: T) => R): MaybePromise<R>` in `runtime/async-util.ts` — applies `fn` inline when `value` is concrete, chains `.then(fn)` only when pending. Note this is the **transform** form, a slight generalization of the ticket's suggested one-arg `resolveMaybe<T>(v): T | Promise<T>`. Reason: the literal one-arg signature is an identity passthrough (both branches return `v`) and cannot eliminate the hop — a value-returning helper the caller then `await`s just reintroduces the microtask. The `await` must be lexical at the call site. So the design is:

- **Transform sites** — where the resolved value is mapped before use — route through `resolveMaybe`: `filter.ts` (truthiness) and `join.ts` `conditionMet` (`!!` boolean coercion).
- **Pure-extraction sites** — where the value is collected/consumed as-is — inline the same `raw instanceof Promise ? await raw : raw` branch directly (wrapping an identity `fn` would add a redundant check and still need the inline await). This covers `project`, `returning`, `bloom-join`/`merge-join` residuals, `window` (×4), `constraint-check` (×2), `view-mutation`.

`join.ts`'s `conditionMet` changed return type from `Promise<boolean>` (was `async`) to `MaybePromise<boolean>`; both call sites (`driveFromLeft`, `driveFromRight`) now branch inline.

### Sites deliberately NOT converted

- `dml-executor.ts:376,395` — `return await evaluator(rctx)` nested inside `withAsyncRowContext(..., async () => …)` wrappers. The enclosing closure is already `async` and its Promise is awaited by `withAsyncRowContext`, so the wrapper's hop dominates; removing the inner `await` saves nothing. Left as-is.
- `recursive-cte.ts:34,35` — LIMIT/OFFSET evaluated **once per query**, not per row. Not a hot path.

## How to validate

- **Build/typecheck:** `yarn workspace @quereus/quereus run build` — clean.
- **Lint (eslint + test-file tsc):** `yarn workspace @quereus/quereus run lint` — clean.
- **Full logic suite:** `yarn workspace @quereus/quereus run test` — **6469 passing, 9 pending**.
- **Perf sentinels** (`test/performance-sentinels.spec.ts`, run within the suite) pass with headroom — they exercise every converted path: full scan, filtered scan (predicate → `filter`), GROUP BY, ORDER BY (`window`/sort keys), bloom self-join (`bloom-join` residual + `join` condition), correlated subquery (`project` columns), bulk insert / constraint path (`constraint-check`).

### Behavioral correctness to spot-check
- Filter predicates still filter correctly (truthiness of 0/false/NULL vs non-zero) — `asPredicateScalar` + `isTruthy` unchanged, just wrapped.
- Join ON / USING / cross (no predicate) all still match — `conditionMet` logic identical, only the async plumbing changed.
- An **async** scalar sub-program (a scalar subquery that genuinely returns a promise) must still evaluate correctly through each path — the `instanceof Promise` branch preserves this. Existing correlated-subquery and subquery logic tests cover it indirectly.

## Known gaps / floor for reviewer

- **No before/after throughput delta measured.** There is no microbenchmark harness that emits a rows/sec number; the perf sentinels are pass/fail thresholds (10–50× headroom), not deltas. The win here is structural (eliminating N×k microtask hops), not a measured figure. If a hard number is wanted, a reviewer could add a targeted microbench (e.g. a wide projection over ~100k in-memory rows, wall-clock before/after). I did not fabricate a delta.
- **No test directly asserts the no-hop property.** Microtask-count assertions are brittle; I relied on the existing suite for correctness and sentinels for non-regression. A reviewer wanting an explicit guard could add a test that a scalar sub-program returning a real `Promise` (forcing the async branch) still projects/filters correctly at each site — the current suite exercises this only incidentally.
- **`resolveMaybe` has two direct call sites** (filter, join). This is intentional per the transform-vs-extraction split above; if the reviewer prefers uniform helper usage, note the extraction sites cannot route through a value-returning helper without reintroducing the hop.
- **`view-mutation.ts` converted, `dml-executor.ts` skipped.** If UPSERT `WHERE`/assignment evaluation ever shows up as hot, revisit `dml-executor.ts:376,395` — but conversion there requires unwinding the `withAsyncRowContext` async closures, which is a larger change than this ticket's scope.
