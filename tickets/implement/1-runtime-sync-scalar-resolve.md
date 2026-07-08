----
description: The engine pauses to wait on a background task for every value it computes in each row, even though that task has almost always already finished — wasting time on millions of needless waits during large queries.
files: packages/quereus/src/runtime/emit/filter.ts, packages/quereus/src/runtime/emit/project.ts, packages/quereus/src/runtime/emit/join.ts, packages/quereus/src/runtime/async-util.ts
difficulty: medium
----
The runtime evaluates scalar sub-programs (a filter predicate, each projected column expression, a join condition) by calling into a sub-scheduler and unconditionally `await`-ing the result: `await predicate(rctx)`, once per column in a projection. In the overwhelmingly common case the sub-scheduler completes synchronously and returns a plain value, not a `Promise` — but the `await` still forces a microtask hop. A k-column projection over N rows pays N×k needless microtask suspensions.

Expected behavior: when the sub-program returns a concrete value, use it directly with no scheduling hop; only `await` when the return is actually a `Promise`. This preserves full async correctness (async sub-programs still work) while eliminating the per-row/per-column overhead on the synchronous hot path.

Direction: introduce a shared helper (e.g. `resolveMaybe`) that checks `value instanceof Promise` and either returns the value directly or awaits it, and route the per-row scalar evaluation sites through it. The sub-program invocation type becomes `T | Promise<T>`; keep the change localized to the evaluation sites and the helper.

Affected sites called out by the review: `runtime/emit/filter.ts:30` (predicate), `runtime/emit/project.ts:39` (per projected column), `runtime/emit/join.ts:92` (join condition). Scan the emit/ directory for other per-row `await <subprogram>(rctx)` sites and convert them consistently.

## TODO
- Add a `resolveMaybe<T>(v: T | Promise<T>): T | Promise<T>` helper (branch on `instanceof Promise`) in `runtime/async-util.ts` (or nearest shared util).
- Convert the per-row predicate await in `runtime/emit/filter.ts` to use it, keeping the enclosing generator async so a genuine promise still awaits.
- Convert the per-column await loop in `runtime/emit/project.ts`.
- Convert the join-condition await in `runtime/emit/join.ts`.
- Grep emit/ for other per-row `await`-on-subprogram sites; convert the ones that share this synchronous-common-case shape.
- Confirm existing perf sentinels and the full logic-test suite pass; note any measured before/after row-throughput change in the handoff.
