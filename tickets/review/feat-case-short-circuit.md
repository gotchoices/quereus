description: A SQL `CASE` no longer runs branches it never selects, so a branch that would error (divide-by-zero, throwing function, a subquery) only runs when its condition actually matches — matching standard SQL.
files: packages/quereus/src/runtime/emit/case.ts, packages/quereus/test/case-short-circuit.spec.ts, packages/quereus/test/logic/03-expressions.sqllogic, docs/runtime.md

## What was built

`emitCaseExpr` (`runtime/emit/case.ts`) now short-circuits **unconditionally**.
Previously every WHEN/THEN/ELSE was emitted as an eager scheduler `param`, so the
scheduler evaluated all of them before `run` picked one — wrong on perf *and*
correctness (an unmatched branch could throw or run a subquery it should never
touch). Now:

- The simple-`CASE` **base** expr stays an eager param (always needed, evaluated
  exactly once per row).
- Every **WHEN / THEN / ELSE** is emitted as an on-demand callback via
  `emitCallFromPlan` and invoked lazily, in SQL order, stopping at the first match.
  Later clauses are never touched once one matches.

Evaluation order (searched): for each clause `w = whenFn(ctx)`; if `isTruthy(w)`
return `thenFn(ctx)`; else fall through; finally `elseFn(ctx)` or `null`.
Simple `CASE` is identical except the match test is
`base !== null && w !== null && compareSqlValues(base, w) === 0` (NULL base / NULL
WHEN never match → fall to ELSE/NULL). These are the *same* `isTruthy` /
`compareSqlValues` the old eager `run` used — semantics preserved.

**Sync-fast-path preservation (the non-obvious part).** The `run` returns
`MaybePromise<SqlValue>` and stays fully synchronous whenever the invoked branch
callbacks resolve synchronously — it does **not** declare `async`. It walks the
clauses with an `instanceof Promise` check per WHEN (mirroring the AND/OR
short-circuit and `docs/runtime.md` § "Avoid a per-row microtask hop on the
synchronous fast path"), taking the promise branch only for a genuinely async
branch (e.g. a scalar-subquery operand). This is load-bearing: the first
`async`-declared draft passed all the new CASE tests but **broke** the
materialized-view row-time projection gate (`compileSourceRowEvaluator` in
`database-materialized-views-analysis.ts`), which throws on a `Promise` result for
a gated single-row scalar — a CASE in a covering-structure body hit that path. The
sync version is required, not just an optimization. See the "Watch for" note below.

The instruction note changed from `case(...)` to `case(short-circuit, N when
clauses[, else])` so EXPLAIN / `getDebugProgram()` shows the short-circuit shape.
The stale `// TODO: consider making all of these calls for short-circuiting` is gone.

## Behavior change (intended)

`select case when 1=1 then 'ok' else throwing_udf() end` returns `'ok'` where it
previously **raised**. Same for any unmatched THEN/ELSE that would divide-by-zero,
throw, or run a side-effecting subquery. This matches SQL: a CASE does not
guarantee evaluation of unselected branches. (Note: bare division-by-zero here
returns NULL, not an error — `1/0` in `binary.ts` yields NULL — so the error-branch
tests use a throwing UDF, not `1/0`.)

## How to validate

- `yarn workspace @quereus/quereus test` — full suite **6958 passing, 13 pending,
  0 failing**.
- `yarn workspace @quereus/quereus lint` — eslint + test-file typecheck, exit 0.

New spec `test/case-short-circuit.spec.ts` (uses non-deterministic
`createScalarFunction` UDFs so the optimizer cannot constant-fold/hoist them):

- **Unmatched branch never runs** — throwing `boom()` in an unmatched ELSE / THEN;
  CASE returns the matched value instead of raising (the headline fix).
- **First-match wins** — throwing `boom()` in a *later* WHEN and a *later* THEN
  than the one that matched; no error.
- **Side-effect counter** — counting `sidefx()` in ELSE; over 3 rows that all match
  a WHEN, counter stays `0`; over rows where one falls through, counter is exactly
  `1`.
- **Base evaluated once** — `case sidefx() when 1 ... when 2 ... when 3 ... end`
  over 3 rows increments the counter `3` (once per row), not `9` (once per WHEN).
- **Correlated subquery THEN** resolves its outer row when selected; skipped when
  its clause is not chosen.
- **Semantic parity** — NULL base, NULL WHEN, no-ELSE → NULL.

Extended `test/logic/03-expressions.sqllogic` (CASE section) with no-ELSE-NULL,
NULL-base-falls-to-ELSE, NULL-WHEN, and first-match-wins end-to-end cases.

Docs: `docs/runtime.md` § "Avoid a per-row microtask hop…" gained a
"Short-circuiting operators reuse this pattern" note covering CASE (always
short-circuits, no cost gate) and the MV-gate sync requirement. `docs/sql.md` is
grammar-only (no evaluation-semantics prose) — left unchanged.

## Review findings

Implement-stage self-review. Build + full test suite + lint all green.

**Watch for (reviewer — highest-value checks):**

- **The sync-return invariant is a real constraint, not a style choice.** If you
  refactor `emitCaseExpr`, do **not** collapse the `instanceof Promise` walk into an
  `async` run — it re-breaks materialized-view maintenance for any view body
  containing a CASE. The regression is covered by
  `test/incremental/maintenance-equivalence.spec.ts` ("CASE expression column"),
  which is where the first draft failed. Confirm that test still passes after any
  change here.
- **Recursion depth.** The clause walk (`step(i)`) recurses once per WHEN clause.
  Fine for realistic clause counts; a pathological CASE with thousands of WHENs on
  a fully-synchronous path would recurse that deep. Not guarded (parser-bounded in
  practice) — flag only if you think a limit is warranted. `case.ts`.

**Test-coverage gaps (this is a floor, not a ceiling):**

- No test asserts the *async* branch path (a scalar-subquery THEN/ELSE that returns
  a Promise) beyond the single correlated-subquery case — the correlated test does
  exercise the promise branch, but a non-correlated async THEN and an async WHEN
  condition are untested. Likely fine (same code path) but unproven.
- No EXPLAIN/`getDebugProgram()` assertion on the new `short-circuit` note (the
  AND/OR ticket added such emit-gate assertions; CASE has none, since there is no
  gate to prove — every CASE short-circuits — but a reviewer may still want a
  note-shape smoke test).
- `.sqllogic` cannot register UDFs, so the throwing/counting non-evaluation proofs
  live only in the `.spec.ts`; the `.sqllogic` additions cover semantic parity only.

**No new tickets filed.** Unlike the AND/OR prereq (which spun off
`feat-where-conjunct-cost-ordering` for a filter-planning gap), CASE has no
orthogonal follow-on: it always short-circuits, there is no cost gate to tune, and
no separate subsystem governs its evaluation.
