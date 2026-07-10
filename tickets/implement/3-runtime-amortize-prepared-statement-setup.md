description: A query you prepare once and run many times currently rebuilds its internal execution machinery and re-checks the whole database structure on every single run; do that setup work once per run instead.
prereq:
files: packages/quereus/src/core/statement.ts, packages/quereus/src/runtime/emitters.ts, packages/quereus/src/runtime/emission-context.ts, packages/quereus/src/runtime/scheduler.ts
difficulty: medium
----

Two independent per-execution overheads on an already-prepared statement, both fixed
by amortizing setup to once per execution. They share the exact call site
(`Statement._iterateRowsRawInternal`) and a single lifetime rule, so they land together.

## Background

`Statement` already caches the optimized plan (`this.plan`) and the emission context
(`this.emissionContext`), and invalidates both together whenever the plan becomes stale
(`nextStatement()`, `finalize()`, and the schema-change listener installed in
`compile()`). What it does **not** cache is the emitted instruction tree and its
`Scheduler`, and it validates captured schema objects far too often.

### (a) Instruction tree + Scheduler rebuilt every execution

`_iterateRowsRawInternal` (`statement.ts` ~L322-327) runs, on **every** execution:

```typescript
const emissionContext = this.getEmissionContext();          // cached ✔
const rootInstruction = emitPlanNode(blockPlanNode, emissionContext);  // rebuilt �’
const scheduler = new Scheduler(rootInstruction);                      // rebuilt ✗
```

`emitPlanNode` walks the whole plan tree and allocates a fresh closure-based
instruction tree; `new Scheduler` re-linearizes it. Neither depends on anything that
varies between executions:

- Emitters take only `(plan, EmissionContext)`. They have **no access to bound
  parameter values** — `?1` etc. resolve at runtime from `ctx.params`, never at emit
  time. So the instruction tree is value-independent.
- The tree's validity is exactly the `emissionContext`'s validity, which is already
  tied to the compiled plan and invalidated on any schema-dependency change via the
  existing listener.

**Design decision (resolves the plan ticket's open question):** the cache key is the
*lifetime* of the cached `(plan, emissionContext)` pair — **not** a content
fingerprint. Cache the `Scheduler` on the Statement and null it in lockstep with
`this.emissionContext`. A separate emission-context content fingerprint was considered
and rejected: it would re-derive information the existing identity-based invalidation
already carries, and every path that can stale the instruction tree already nulls
`emissionContext`.

### (b1) Schema re-validation per instruction (and per NLJ inner row)

`createValidatedInstruction` (`emitters.ts:157`) wraps each schema-capturing
instruction's `run` so it calls `emissionContext.validateCapturedSchemaObjects()`
before running. That method iterates the **entire** captured snapshot
(`emission-context.ts:286`). Because every capturing instruction shares the one
`emissionContext`, cost is O(#capturing-instructions x snapshot-size) per execution —
and inside an un-cached nested-loop-join inner it re-fires per outer row.

Six emitters call `createValidatedInstruction`: `scan.ts`, `cte-reference.ts`,
`envelope-scan.ts`, `internal-recursive-cte-ref.ts`, `scalar-function.ts`,
`table-valued-function.ts`. All of their instructions execute within one execution's
`scheduler.run`, under one `emissionContext`. So a **single** validation call at
execution start covers every one of them.

**Design decision:** hoist validation to once per execution. Call
`emissionContext.validateCapturedSchemaObjects()` once in `_iterateRowsRawInternal`
just before `scheduler.run(runtimeCtx)` (skip when `getCapturedObjectCount() === 0`).
Strip the per-run validation wrapper from `createValidatedInstruction` so it returns a
plain `{ params, run, note }`. This is still run-time validation (after any
schema-change listener would have fired) and remains a defensive existence check for a
schema change racing execution setup — just paid once, not per instruction.

## Expected behavior

Preparing once and executing N times emits + schedules the instruction tree **once**
(rebuilt only on recompile / schema-dependency change) and validates captured schema
**once per execution**, with identical results to today on every run.

## Edge cases & interactions

- **Scheduler lifetime == emissionContext lifetime.** Null `this.scheduler` (and the
  cached root instruction, if stored separately) at *every* site that sets
  `this.emissionContext = null`: `nextStatement()` (L118), the schema-change listener
  callback (L212), and `finalize()` (L472). Add the null adjacent to each existing one
  so the rule can't drift. First-compile path: scheduler is built lazily in
  `_iterateRowsRawInternal` only when `!this.scheduler`.
- **Metrics stats accumulation.** With a cached `Scheduler`, `instruction.runtimeStats`
  persists across executions; `metricsHooks.onStart` only initializes stats when
  *absent*, so a reused scheduler would accumulate counts across runs and change
  per-execution metrics semantics. Fix: in `metricsHooks.onStart`, reset each
  instruction's stats to zero (in/out/elapsedNs/executions) rather than only creating
  when missing. Verify `runtime_metrics`-enabled runs report per-execution numbers.
- **Tracing / `trace_plan_stack`.** `emitPlanNode` bakes `instrumentRunForTracing` into
  `instruction.run` at emit time based on `emissionContext.tracePlanStack` (read once at
  EmissionContext construction). Per-run tracer wrapping lives in the scheduler hooks,
  not baked, so a cached scheduler serves both traced and untraced runs. Toggling the
  `trace_plan_stack` db option mid-life is already ignored today (emissionContext is
  cached), so caching the scheduler does not regress it — record this as a `// NOTE:`
  tripwire at the cache site, don't file a ticket.
- **`getDebugProgram()`** (statement.ts:780) emits + builds its own scheduler
  separately. Leave it as-is (debug-only path); do not force it through the cache.
- **`iterateRowsWithTrace` / metrics / plain runs share the cached scheduler.** Confirm
  the cached scheduler is created independent of the per-run `tracer`/`enableMetrics`
  overrides (those are read into `runtimeCtx`, not into the scheduler build) — a
  statement executed once traced and once plain must reuse the same scheduler.
- **`emissionContext` field on `Instruction`.** Only `createValidatedInstruction` sets
  it and nothing reads it for behavior; dropping it from the returned instruction is
  safe. Grep to confirm before removing (keep the type field optional).
- **Zero-capture statements.** `getCapturedObjectCount() === 0` (e.g. a pure `values`
  or constant expression) must skip the central validation entirely — same as today's
  early return in `createValidatedInstruction`.
- **Re-entrant sub-programs.** `emitCall`/`emitCallFromPlan` build inner `Scheduler`s
  baked into the cached instruction tree; they are captured once at emit and reused
  across executions for free. No separate handling needed — just confirm join/subquery
  suites stay green.

## TODO

- Add `private scheduler: Scheduler | null = null;` (and cache the root instruction if
  convenient) to `Statement`; build lazily in `_iterateRowsRawInternal` only when
  unset; null it alongside every `this.emissionContext = null`.
- Hoist validation: add one `emissionContext.validateCapturedSchemaObjects()` call
  (guarded by `getCapturedObjectCount() > 0`) before `scheduler.run` in
  `_iterateRowsRawInternal`.
- Simplify `createValidatedInstruction` to return `{ params, run, note }` (drop the
  per-run validation wrapper and the `emissionContext` field on the instruction). Keep
  the function + call sites so the six emitters are untouched.
- Reset per-instruction `runtimeStats` in `metricsHooks.onStart` instead of
  create-if-absent.
- Add a `// NOTE:` tripwire at the scheduler-cache site re: mid-life `trace_plan_stack`
  toggling being ignored (pre-existing, unchanged by this work).
- Tests: prepare once, execute many times, assert (1) identical result rows across
  runs for a representative query (scan + join + scalar fn), (2) with `runtime_metrics`
  on, `getMetrics()` reflects a *single* execution's counts (not accumulated), (3) a
  statement that captures a table then the table is dropped between executions still
  raises the "was dropped after query was planned" error on the next run (validation
  still fires once), (4) toggling schema (add/drop a dependency) forces a rebuild and
  correct new results.
- Run `yarn build`, `yarn lint` (quereus: eslint + `tsc -p tsconfig.test.json`),
  `yarn test`. Stream long output with `2>&1 | tee`.
