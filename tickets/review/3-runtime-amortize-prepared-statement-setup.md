description: A prepared query now builds its execution machinery once and reuses it across runs, instead of rebuilding it and re-checking the whole schema on every run — review that the caching is correct and doesn't leak stale state between runs.
prereq:
files: packages/quereus/src/core/statement.ts, packages/quereus/src/runtime/emitters.ts, packages/quereus/src/runtime/emission-context.ts, packages/quereus/src/runtime/scheduler.ts, packages/quereus/src/runtime/emit/subquery.ts, packages/quereus/src/runtime/types.ts, packages/quereus/src/runtime/parallel-driver.ts, packages/quereus/test/prepared-statement-amortization.spec.ts, packages/quereus/test/runtime/fork-contract.spec.ts, docs/runtime.md
difficulty: medium
----

Implement stage done. `yarn build`, `yarn lint` (eslint + `tsc -p tsconfig.test.json`),
and `yarn test` (whole workspace) all pass: quereus 6889 passing / 13 pending, every
other package green.

## What changed (and why it's correct)

Two per-execution overheads on an already-prepared statement were amortized to once
per execution, plus **one regression the caching introduced was found and fixed** —
that fix is the part most worth an adversarial look.

### (a) Instruction tree + Scheduler cached on the Statement

`Statement` gained `private scheduler: Scheduler | null`. `_iterateRowsRawInternal`
builds it lazily only when unset (`emitPlanNode` + `new Scheduler`) and reuses it
across executions. The cache key is the *lifetime* of the cached
`(plan, emissionContext)` pair — the scheduler is nulled in lockstep with
`this.emissionContext = null` at all three sites: `nextStatement()`, the schema-change
listener callback, and `finalize()`. No content fingerprint.

Why value-independent: emitters see only `(plan, EmissionContext)`; bound params
resolve at run time from `ctx.params`, never at emit time.

### (b) Schema validation hoisted to once per execution

`createValidatedInstruction` no longer wraps each capturing instruction's `run` with a
`validateCapturedSchemaObjects()` call. It now returns a plain `{ params, run, note }`
(and no longer sets the `emissionContext` field on the instruction; the optional type
field is retained — grep confirmed nothing reads it for behavior). Validation is now a
single call in `_iterateRowsRawInternal` before `scheduler.run`, guarded by
`getCapturedObjectCount() > 0`. Six emitters (`scan`, `cte-reference`, `envelope-scan`,
`internal-recursive-cte-ref`, `scalar-function`, `table-valued-function`) still call
`createValidatedInstruction` unchanged.

### Metrics reset (edge case from the ticket)

`Scheduler.metricsHooks.onStart` now **resets** each instruction's `runtimeStats` to
zero rather than create-if-absent, so a reused scheduler reports per-execution counts
instead of accumulating across runs.

### The regression the ticket did NOT anticipate — impure subquery memo (review focus)

The impure (DML-bearing) scalar / `IN` / `EXISTS` subquery emitters
(`runtime/emit/subquery.ts`) memoize "run the inner DML exactly once per statement
execution". That memo used to live in the **emit-time closure** and reset *only because
the Statement re-emitted per execution*. With the cached instruction tree the closure
now persists across executions — so a prepared statement with a side-effecting subquery
would have fired its inner DML only on the **first** run and replayed the memoized
result forever after. The existing `01.9-query-expr-dml.sqllogic` suite runs each
statement once via `exec`, so it stayed green and did **not** catch this.

Fix: the memo moved onto the per-execution `RuntimeContext` (`ctx.executionMemo:
Map<symbol, {value}>`), keyed by a unique symbol minted per emit site. A fresh
RuntimeContext is built per execution (statement.ts:353) and threaded by identity
through the whole execution — there is no context forking in `runtime/` (verified by
grep: no `{...ctx}` / no extra `RuntimeContext = {` construction inside emit), so
correlation re-reads via the shared `ctx.context` and the memo resets exactly per
execution while still de-duping within one execution.

**Reviewer: please scrutinize this.** The claim "one RuntimeContext per execution,
threaded by identity, never forked during normal (non-parallel) execution" is the load
bearing invariant. If any execution path *does* hand a different RuntimeContext object
to a re-invoked impure subquery within a single execution, the within-execution
run-once dedup would break (DML would fire more than once). The new tests exercise the
scalar and per-row `EXISTS` cases; `IN(impure)` has the same shape but is only covered
transitively — an explicit prepared-twice `IN(impure)` case would strengthen it.

## Fork-contract interaction (parallel runtime)

`RuntimeContext` gained a field, which trips the compile-time fork-policy gate in
`test/runtime/fork-contract.spec.ts`. `executionMemo` is declared `shared-cooperative`
(shared by reference across forks — matching the pre-cache single-closure memo, which
was one shared cell for all branches) and aliased in `ParallelDriver.fork()`. The
"shared fields aliased" test seeds a `new Map()` sentinel for it, same as
`activeConnection`.

## Tripwires recorded (NOT tickets)

- **`trace_plan_stack` mid-life toggle is ignored** until recompile — the tracing wrap
  is baked at emit time and the emission context is cached. Pre-existing behavior,
  unchanged by this work. `// NOTE:` at the scheduler-cache site in `statement.ts`.
- **`executionMemo` lazy-init vs. future parallelism** — the memo is lazily created on
  first impure-subquery run, so it is `undefined` at fork time in the common case. If a
  future parallelized query ever drives an impure subquery *inside* a fork, each branch
  would lazily make its own memo and the inner DML would fire once per branch. Dormant
  today: `ParallelDriver` has zero query consumers. NOTE at `ParallelDriver.fork()`
  documenting that such a future must eagerly create the memo on the parent before
  forking. Not filed as a ticket because it is genuinely conditional (dormant path).

## Tests to validate / extend

New spec `packages/quereus/test/prepared-statement-amortization.spec.ts` (6 tests, all
white-box on the private `scheduler` via a typed cast):
1. prepare once, execute 3× over scan+join+scalar-fn → identical rows + same scheduler
   instance reused.
2. `runtime_metrics` on → second execution's summed `executions` equals the first's
   (reset, not accumulated).
3. drop a captured table between executions → next run errors. **Note the actual
   behavior:** the schema-change listener wins the race and forces a recompile, so the
   error is `Table 't' not found in schema path` (planning), **not** `was dropped after
   query was planned` (the validation backstop). The test matches either message. The
   validation-path error is genuinely hard to trigger under a normal drop because the
   listener preempts it — it is a race-only backstop. A reviewer wanting to pin the
   validation path specifically would need to bypass the listener (e.g. a dependency
   type the listener doesn't map).
4. drop+recreate a dependency with new rows → scheduler rebuilt (different instance) +
   correct new results.
5. impure scalar-subquery DML re-fires on every execution of a prepared statement
   (regression guard; uses a distinct bound value per run because no-PK tables key on
   their columns).
6. per-row `EXISTS` DML keeps run-once-per-execution across executions.

`test/runtime/fork-contract.spec.ts` updated for the new field.

### Known gaps / floor, not ceiling

- No `IN(impure)` prepared-twice test (see above).
- Test 3 does not force the `validateCapturedSchemaObjects` throw path (listener
  preempts). Consider whether that backstop deserves a direct unit test against
  `EmissionContext` rather than through `Statement`.
- No test asserts the cached scheduler is shared between a *traced* run and a *plain*
  run of the same statement (the ticket called this out as an interaction). Manually
  reasoned safe — the scheduler build ignores per-run `tracer`/`enableMetrics` (those
  go into `runtimeCtx`, not the build) — but not pinned by a test.
- `getDebugProgram()` still emits + builds its own throwaway scheduler (left as-is per
  the ticket; debug-only path).

## Docs

`docs/runtime.md` § impure subquery emitters updated: the run-once memo now lives on
`ctx.executionMemo`, not the emit-time closure. The prepared-statement auto-invalidation
section still reads correctly (recompile-on-schema-change now also rebuilds the
scheduler).
