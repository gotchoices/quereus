description: The engine used to pause and wait on a background task for every value it computed per row, even though that task had almost always already finished; it now uses finished values directly and only waits when a value is genuinely still pending.
files: packages/quereus/src/runtime/async-util.ts, packages/quereus/src/runtime/emit/filter.ts, packages/quereus/src/runtime/emit/project.ts, packages/quereus/src/runtime/emit/join.ts, packages/quereus/src/runtime/emit/returning.ts, packages/quereus/src/runtime/emit/bloom-join.ts, packages/quereus/src/runtime/emit/merge-join.ts, packages/quereus/src/runtime/emit/window.ts, packages/quereus/src/runtime/emit/constraint-check.ts, packages/quereus/src/runtime/emit/view-mutation.ts, docs/runtime.md
difficulty: medium
----

## What shipped

Per-row scalar sub-programs (filter predicate, projected columns, join
condition, join residual predicates, window partition/order keys, constraint
checks, view-mutation key default) were evaluated with an unconditional
`await subprogram(rctx)`. The sub-scheduler runs synchronously until it hits a
genuinely-async instruction, so in the common case it returns a concrete value —
but `await concreteValue` still schedules a microtask (`await x` ≡
`await Promise.resolve(x)`), so an N-row × k-column query paid N×k needless
microtask suspensions.

Fix: branch on `value instanceof Promise` at each per-row site — use the value
directly when concrete, `await` only when genuinely pending. New helper
`resolveMaybe<T,R>(value, fn)` in `runtime/async-util.ts` for the transform
sites (filter truthiness, join `!!` coercion); extraction sites inline the
`raw instanceof Promise ? await raw : raw` branch. `join.ts`'s `conditionMet`
dropped `async`, now returns `MaybePromise<boolean>`; both call sites branch.

## Review findings

**Verdict: implementation is sound and complete. No major findings; no new
tickets filed. One doc-accuracy gap fixed inline.**

### Checked — correctness
- **`instanceof Promise` vs thenable.** The change replaces `await x` (which
  also handles non-Promise thenables) with an `instanceof Promise` branch. Safe:
  `scheduler.ts` itself decides async transitions with `output instanceof Promise`
  (scheduler.ts:165, 355), so instructions only ever return a native `Promise` or
  a concrete value — the codebase already assumes this everywhere. Callback path
  (`emitCall` → `Scheduler.run`, a native async method) returns a native Promise
  or concrete value; the tracing wrapper's `.finally` on a native Promise stays a
  native Promise. No path yields a non-Promise thenable to these sites.
- **Ordering / serialization preserved.** Every converted site kept its
  sequential `for` loop with a lexical `await` on the pending branch; columns and
  keys still resolve in order. The `returning.ts` / `project.ts` "sequential to
  avoid shared-RowSlot race" invariant is intact (no parallelization introduced).
- **Error propagation unchanged.** `resolveMaybe` runs `fn` inline (throws in
  caller, as `await` did) or chains `.then(fn)` (rejects, as before). Rejection
  on the async branch still surfaces via the lexical `await`.
- **Async sub-programs still work.** A scalar sub-program that genuinely returns
  a promise (e.g. correlated subquery) takes the `instanceof Promise` branch and
  awaits — behavior identical to before. Existing subquery/correlated tests cover
  this indirectly.
- **`conditionMet` call sites.** grep confirms exactly 3 references in join.ts
  (1 def + 2 call sites), both call sites converted. No stragglers.

### Checked — coverage of sites
- Grepped all `await …(rctx)` per-row callback sites under `runtime/emit/`. Only
  `dml-executor.ts:376,395` remain unconverted — correctly skipped: both are
  nested inside `withAsyncRowContext(..., async () => …)` closures whose Promise
  dominates, so removing the inner `await` saves nothing. `recursive-cte.ts`
  LIMIT/OFFSET is per-query, not per-row — correctly out of scope.

### Checked — build / lint / tests (all green)
- `yarn workspace @quereus/quereus run lint` — clean (eslint + test-file tsc), exit 0.
- `yarn workspace @quereus/quereus run test` — **6469 passing, 9 pending**, exit 0.
  Perf sentinels (full/filtered scan, GROUP BY, ORDER BY, bloom self-join,
  correlated subquery, bulk-insert constraint path) pass — exercise every
  converted path.

### Found & fixed inline (minor) — stale docs
`docs/runtime.md` taught the pre-change pattern as canonical: line ~771 showed
the constraint context-eval loop with bare `await contextEvaluator(rctx)`, and
the "Scheduler-Centric Execution Model" pitfall (line ~1647) showed
`await conditionCallback(rctx)` as the ✅-CORRECT per-row form. After the change
these both contradicted reality and would steer future emitters into
reintroducing the hop. Fixed: updated both snippets to the branch/`resolveMaybe`
form and added a dedicated "avoid a per-row microtask hop" note documenting the
extraction-vs-transform split and *why* `instanceof Promise` (not a duck-typed
`.then`) is the right test.

### Tripwire (recorded, not a ticket)
- **Extraction-site duplication.** The `raw instanceof Promise ? await raw : raw`
  branch is inlined ~9× rather than routed through a helper. This is deliberate
  and unavoidable — the `await` must be lexical at the extraction point, so a
  value-returning helper cannot host it without reintroducing the hop. Fine as-is;
  *if* this pattern proliferates much further and drifts, consider an eslint rule
  keying on `await <ident>(rctx)` in per-row loops rather than a runtime helper.
  The pattern is now documented in `docs/runtime.md` so future emitters copy the
  right shape.

### Not done (accepted floor, from implement handoff)
- **No before/after throughput number.** The win is structural (eliminating N×k
  microtask hops); perf sentinels are pass/fail thresholds, not deltas, and no
  microbench harness emits a rows/sec figure. A reviewer wanting a hard number
  could add a targeted microbench (wide projection over ~100k in-memory rows).
  Not required for correctness/non-regression, which the suite + sentinels cover.
- **No test directly asserts the no-hop property.** Microtask-count assertions
  are brittle; correctness is covered by the existing suite exercising both the
  sync and async branches. Left as-is intentionally.
