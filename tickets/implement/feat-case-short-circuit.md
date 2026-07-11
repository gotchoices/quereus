----
description: A SQL `CASE` expression currently evaluates every branch up front, so a branch that never matches still runs — wasting work and, worse, raising an error from a branch that was never supposed to execute.
prereq: feat-and-or-short-circuit
files: packages/quereus/src/runtime/emit/case.ts, packages/quereus/src/runtime/emit/limit-offset.ts, packages/quereus/src/runtime/emitters.ts, packages/quereus/test/logic/03-expressions.sqllogic
difficulty: medium
----

## Problem

`emitCaseExpr` in `runtime/emit/case.ts` emits **every** WHEN, THEN, and ELSE sub-expression as an eager `param` (there is even a `// TODO: consider making all of these calls for short-circuiting` at line 72). The scheduler evaluates all of them before `run` selects one. This is wrong on two axes:

- **Perf:** every branch runs on every row even though at most one THEN (or the ELSE) is ever returned.
- **Correctness (the real bite):** SQL says a `CASE` evaluates WHEN clauses left-to-right, stops at the first match, and evaluates only the selected result. Evaluating all branches eagerly means a branch that should never run — e.g. an ELSE that divides by zero, or a THEN that calls a throwing function — can raise an error or produce a spurious value even when an earlier WHEN matched. `select case when 1=1 then 'ok' else throwing_udf() end` currently errors; it must return `'ok'`.

## Chosen design: full short-circuit, no cost gate

Unlike `AND`/`OR` (see prereq `feat-and-or-short-circuit`, where a cost/subquery gate keeps the cheap common case eager), `CASE` must **always** short-circuit — correctness requires that unmatched branches never execute, regardless of how cheap they look. So convert WHEN / THEN / ELSE to on-demand callbacks unconditionally. The base expression of a *simple* `CASE` stays eager (it is always needed, evaluated exactly once).

### Mechanism — same callback pattern as the prereq

Use `emitCallFromPlan(plan, ctx)` (`runtime/emitters.ts:148`), the same one `feat-and-or-short-circuit` and `runtime/emit/limit-offset.ts` use. Each WHEN/THEN/ELSE becomes a `(ctx: RuntimeContext) => MaybePromise<SqlValue>` callback; `run` becomes `async` and `await`s only the callbacks it actually needs. The scheduler already handles a `Promise`-returning `run` by switching to its async loop (`runtime/scheduler.ts:206`) — no scheduler change.

### Evaluation order (must match SQL exactly)

Searched `CASE` (`CASE WHEN c1 THEN r1 ... ELSE e END`):
```
for each clause in order:
  const w = await whenFn(ctx)
  if (isTruthy(w)) return await thenFn(ctx)   // evaluate ONLY this THEN, stop
return elseFn ? await elseFn(ctx) : null
```

Simple `CASE` (`CASE base WHEN v1 THEN r1 ... ELSE e END`):
```
const base = baseValue   // eager param, evaluated once
for each clause in order:
  const w = await whenFn(ctx)
  if (base !== null && w !== null && compareSqlValues(base, w) === 0) return await thenFn(ctx)
return elseFn ? await elseFn(ctx) : null
```

Later WHENs must **not** be evaluated once an earlier one matches — a later WHEN could itself error. Keep `isTruthy` (searched) and `compareSqlValues` (simple) exactly as the current eager `run` uses them (`case.ts:24` and `:52`).

## Edge cases & interactions

- **Unmatched erroring branch.** The headline correctness fix: an unmatched THEN/ELSE that would throw (or divide, or run a subquery) must not execute. Test with a throwing UDF in the unmatched branch.
- **First-match wins; no later evaluation.** A matching WHEN must short-circuit *before* any later WHEN or THEN is touched. Test with a throwing UDF in a *later* WHEN than the one that matches.
- **No match, no ELSE → NULL** (unchanged).
- **Simple CASE with NULL base.** `base !== null && w !== null && compare === 0` — NULL base never matches any WHEN; falls to ELSE/NULL. Preserve current semantics exactly.
- **Simple CASE base evaluated exactly once**, even across many WHEN comparisons (it is an eager param, not a per-clause callback).
- **Async THEN/ELSE.** A selected branch that is a scalar subquery returns a `Promise`; `await` handles it. A cheap branch resolves effectively synchronously through the sub-program — acceptable overhead.
- **Correlated subquery inside a branch** resolves via the shared `RuntimeContext` passed to the callback (`fn(ctx)`); verify with a correlated-subquery branch, same as the prereq's correlated case.
- **Metrics / tracing.** Each branch becomes its own sub-program (`programs` from `emitCall`); unselected branches run 0 times. Expected — do not assume every branch instruction executes.
- **Empty result / no WHEN clauses** is not reachable (parser requires ≥1 WHEN), but the loop must handle the ELSE-only path correctly.

## Testing

Extend `test/logic/03-expressions.sqllogic` (CASE lives there) and/or a `.spec.ts` using `db.createScalarFunction` for the throwing/counting UDF (see `test/core-api-features.spec.ts`).

- **Non-evaluation of unmatched branch:** `select case when 1=1 then 'ok' else throwing_udf() end` → `'ok'` (currently errors — this proves the fix).
- **Later WHEN not evaluated after earlier match:** throwing UDF in a WHEN *after* the matching one → no error.
- **Side-effect counter:** counting UDF in ELSE; over N rows where every row matches a WHEN, assert counter stays 0.
- **Semantic parity:** re-run existing CASE cases (simple + searched, with/without ELSE, NULL base, NULL WHEN) and confirm results unchanged.
- **Correlated subquery branch** resolves correctly.

## TODO

- Rewrite `emitCaseExpr`: keep the base expr (simple CASE) as an eager param; emit every WHEN/THEN/ELSE via `emitCallFromPlan`; make `runSimpleCase` / `runSearchedCase` `async` and evaluate lazily in order as specified above. Remove the stale `// TODO` at `case.ts:72`.
- Update the `note` to reflect short-circuit emission.
- Add tests: unmatched-erroring-branch, later-WHEN-not-run, side-effect counter, semantic parity, correlated branch.
- Run `yarn workspace @quereus/quereus test` and `yarn lint`. Stream long output with `2>&1 | tee`.
- Update `docs/runtime.md` / `docs/sql.md` if either documents CASE evaluation (note it now short-circuits, matching SQL semantics — this is a behavior change for erroring unmatched branches).
