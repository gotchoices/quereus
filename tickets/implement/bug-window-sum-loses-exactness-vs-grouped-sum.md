---
description: Adding up or averaging very large whole numbers gives the exact answer in a plain query but a slightly wrong one when written as a windowed total, and averages disagree with how materialized views compute them; make the window and average paths reuse the exact summing that plain `sum()` already does.
files:
  - packages/quereus/src/func/builtins/aggregate.ts                 # sumFunc (exact/approx split), avgFunc (float-only — arm 2)
  - packages/quereus/src/func/builtins/builtin-window-functions.ts  # window COUNT/SUM/AVG re-implemented in float (~line 193-248)
  - packages/quereus/src/schema/window-function.ts                  # WindowFunctionSchema — needs initial-state + inverse hooks
  - packages/quereus/src/runtime/emit/window.ts                     # frame walk (~line 548), running agg (~line 1295), sliding helpers slidingStepNum/slidingUnstepNum/slidingFinalAcc/slidingScanSum/slidingScanCountNonNull (~line 1414-1477), StreamingFuncState.slidingAcc (~line 895)
  - packages/quereus/src/planner/rules/window/rule-monotonic-window.ts  # RECOGNIZED_RUNNING_AGG / RECOGNIZED_SLIDING_AGG (read only — the set of names the streaming paths handle)
  - packages/quereus/test/incremental/aggregate-algebra.spec.ts     # avg law-checked over ±1000 only (line ~83)
  - docs/window-functions.md                                        # "{ sum, count } accumulator" description (~line 418)
repro: verified
---

# Window `sum`/`avg` and grouped `avg` lose exactness on large whole numbers

## Reproduction (verified 2026-11-10, in-memory `Database`)

Table `w(id integer primary key, v integer)` with rows `(1, 9007199254740993), (2, 5), (3, 7)`:

| query | got | correct |
|---|---|---|
| `select sum(v) from w` | 9007199254741005 (bigint) | ✔ |
| `sum(v) over ()` | 9007199254741004 (number) ×3 | 9007199254741005 bigint |
| `sum(v) over (order by id)` (running) | …0992, …0996, …1004 | …0993, …0998, …1005 |
| `sum(v) over (order by id rows between 1 preceding and current row)` (ROWS sliding) | …0992, …0996, 12 | …0993, …0998, 12 |
| `sum(v) over (order by id range between 1 preceding and 1 following)` (RANGE sliding) | …0996, …1004, 12 | …0998, …1005, 12 |
| `rows between unbounded preceding and unbounded following` (buffered frame walk) | …1004 | …1005 |

Note even a single-row frame is wrong (`Number(9007199254740993n)` = 9007199254740992), so every window shape is affected, not only accumulation.

Text operands: table `t(id, v text)` with `'9007199254740993'`, `'1'` → grouped `sum(v)` = 9007199254740994 (bigint), `sum(v) over ()` = 9007199254740992.

Arm 2 (no SQL needed): feeding `9007199254740993n, 1` to the registered builtins, `avgFunc` direct finalize → 4503599627370496, while its declared decomposition `combine([sumFunc final, 2])` → 4503599627370497.

## Root cause

Two copies of the summing logic exist besides `sumFunc`:

- **Window registry** (`builtin-window-functions.ts`): its own `COUNT`/`SUM`/`AVG` step/final, all `Number(value)`-based, `SUM` typed `REAL_RETURN`. Used by the buffered frame walk (`window.ts` ~line 564) and the streaming running path (`stepRunningAgg`).
- **Sliding fast paths** (`window.ts`): `slidingAcc: { sum: number; count: number }` with `slidingStepNum` / `slidingUnstepNum` / `slidingFinalAcc` (ROWS) and `slidingScanSum` / `slidingScanCountNonNull` (RANGE) — a third float-only copy that does not consult the schema at all.
- **`avgFunc`** (`aggregate.ts`): accumulates `{ sum: number, count }` with `Number()` — disagrees with its own `decompose` (sum/count), which is what a materialized view uses.

## Decision (maintainer, 2026-11-10 — already settled, do not reopen)

Reuse the grouped accumulator's exact/approximate split (`addSumContribution` / `addWithPromotion`, and `algebra.merge` / `algebra.negate`) instead of keeping float copies. Sliding-frame removal subtracts from the exact part exactly. Text converts through `parseNumericText` (which `sumFunc`'s step already does). Confirm performance with a quick timing on a large sliding window.

## Design

### Arm 2 first: `avg` accumulates as `sum` does

`avgFunc` uses `SumAccumulator` (null initial) and `sumFunc`'s step / merge / negate; finalize is `count === 0 ? null : Number(sumFinal) / count` where `sumFinal` is `sumFunc`'s finalize of the same accumulator. That is literally the decomposition's `combine([sumFinal, count])`, so direct and decomposed avg agree by construction — have `finalize` and `decompose.combine` share one helper so they cannot drift. `SumAccumulator.count` already counts non-NULL numeric contributions, which is exactly avg's divisor. Side effect: avg's handling of non-numeric inputs becomes sum's (text via `parseNumericText`, booleans 1/0, blobs/JSON and non-numeric text skipped). Check `test/logic` for any avg-over-text/boolean expectation that changes.

Known remaining gap, same class (not verified by running; inferred from code): the decomposition's divisor is `count(x)`, which counts every non-NULL value, including non-numeric text and blobs that `sum` skips. So over such a value the direct avg (divisor = numeric contributions) and the decomposed avg (divisor = all non-NULL) differ, both before and after this fix. Do not widen `sumDomain` to include non-numeric text to "test" this. If a quick check confirms it, append it to this ticket's review handoff as a finding; the fix (a different count partial, or a different skip rule) is a separate decision.

`avg` keeps `REAL_RETURN` (the quotient is always a float). Expected after fix: rows `9007199254740993, 1` → 4503599627370497 from both paths.

### Window aggregates derive from the aggregate schemas

Replace the hand-written window `COUNT`/`SUM`/`AVG` registrations with one adapter, e.g. `registerAggregateAsWindowFunction(aggSchema: AggregateFunctionSchema)`, that builds the `WindowFunctionSchema` from the aggregate: `step = aggSchema.stepFunction`, `final = (s) => aggSchema.finalizeFunction(s)`, `returnType = aggSchema.returnType` (so window `sum` becomes `NUMERIC_RETURN` like grouped `sum`), and the two new hooks below. MIN/MAX already share their comparator rule and are out of scope (they need no inverse); leave them.

`WindowFunctionSchema` gains:

- `initial?: () => unknown` — the fresh accumulator. Needed because the runtime starts every accumulator at `null` (frame walk `let accumulator = null`, `makeFuncState` `aggAccumulator = null`), which is wrong for `count(x)` (initial `0`; it only works today because `null + 1 === 1`). Derive from `cloneInitialValue(aggSchema.initialValue)` (`func/registration.ts`). Consume it at every accumulator-start site in `window.ts` (frame walk, running agg start, sliding start, `slidingScanExtremum`'s fold). Default when absent: `null`, preserving MIN/MAX.
- `inverse?: (state, value) => state` — removes one contribution, SQLite's `xInverse`. Derived as `merge(state, negate(step(initial(), value)))` when the aggregate's algebra declares both `merge` and `negate`. For sum the exact part retracts exactly; the approx part subtracts in float as today. `bindWindowSchema` must carry `initial` / `inverse` through unchanged (it spreads `...schema`, so it already does — just don't break it).

### Sliding paths fold through the schema

- ROWS: replace `slidingAcc: { sum; count }` with `slidingAcc: unknown` initialised from `schema.initial()`; `slidingStepNum` → `schema.step`, `slidingUnstepNum` → `schema.inverse`, `slidingFinalAcc` → `schema.final`. Gate: the streaming ROWS path for an aggregate requires `inverse`; `sum`/`count`/`avg` all have it. If a name in `RECOGNIZED_SLIDING_AGG` lacks `inverse` (MIN/MAX — already rescanned), it keeps the rescan.
- RANGE: `slidingScanSum` / `slidingScanCountNonNull` → one generic fold over the buffer slice through `schema.initial/step/final` — generalise `slidingScanExtremum` into a `slidingScanFold` and use it for sum/count/avg/min/max alike. Empty frame: `final(initial())` yields `0` for count and `NULL` for sum/avg/min/max, which is exactly the special case currently hard-coded (`m.name === 'count' ? 0 : null`) — the special case can go.

After this, `window.ts` contains no `Number(argVal)` arithmetic; the only numeric coercion of window arguments lives in `aggregate.ts`. Update the NOTE at `builtin-window-functions.ts` ~line 208 (it points at `slidingStepNum`/`slidingScanSum`, which will no longer exist) — or delete it if the bindArgs concern it describes is now fully covered by the aggregate's own handling.

### Guards (the class, not the instance)

- **Window ↔ grouped equivalence** (one new spec, e.g. `packages/quereus/test/window-aggregate-equivalence.spec.ts`): for every window registry entry with `kind: 'aggregate'` that also resolves as an aggregate function, over a fast-check-generated table whose `v` column draws from large whole numbers (bigints past 2^53 and safe integers near it), dyadic fractions, NULLs, and numeric text, assert that `f(v) over ()` equals grouped `f(v)` **including storage class** (bigint vs number), and that each streaming shape — running `over (order by id)`, ROWS `rows between 2 preceding and 1 following`, RANGE `range between 2 preceding and 1 following` — equals the grouped `f(v)` over the same frame (`select f(v) from w where id between …`). Iterating the registry is what makes it catch the *next* reimplemented aggregate without anyone listing it. Keep `numRuns` modest (~50) — each run builds a table. Dyadic fractions only, as in `sumDomain`, so the test isn't measuring IEEE rounding order between a fold and a slide-and-retract.
  - Caveat to handle, not paper over: the ROWS sliding path computes by retraction, which in the approx (float) part is not bit-identical to a fresh fold in general; dyadic bounded fractions keep it exact. If the property still finds a float-retraction divergence over that domain, that is a real finding — report it, don't widen tolerance.
- **avg over its claimed domain**: in `aggregate-algebra.spec.ts`, change `assertAggregateAlgebraLaws(avgFunc, intOrNull)` to run over `sumDomain` (and fix the `intOrNull` doc comment, which justifies the small domain with "avg sums as floats"). That exercises the decomposition law over large whole numbers and is the arm-2 reproduction.
- One sqllogic case in `test/logic/27-window-edge-cases.sqllogic` pinning the headline example (`sum(v)` vs `sum(v) over ()` over `9007199254740993, 5`) is optional — the spec above covers it; add it only if the spec can't express storage class cleanly.

### Performance check

The decision asks for a timing. Before/after, time a ROWS sliding `sum(v) over (order by id rows between 100 preceding and current row)` over ~200k safe-integer rows (e.g. a throwaway script or `bench/` if one fits; don't commit a bench unless one already exists for windows). The new path allocates a fresh accumulator object per step/inverse (sum's step is immutable); if that is materially slower, note the measured numbers in the review handoff — a mutable fast path inside `aggregate.ts` is an acceptable follow-up, a float copy in `window.ts` is not.

## Related open tickets (different sites in `window.ts`, no overlap)

`bug-window-range-offset-ignores-desc-order` (RANGE bound direction) and `feat-window-streaming-partitioned` (streaming for partitioned windows) touch the same file; if one lands first, rebase onto its shape.

## TODO

Phase 1 — avg
- Rewrite `avgFunc` over `SumAccumulator` with shared finalize/combine helper; keep `decompose` partials unchanged.
- Switch avg's law check to `sumDomain`; fix the `intOrNull` comment.
- Run `yarn workspace @quereus/quereus test` — watch for avg-over-text / avg-over-boolean expectations in `test/logic`.

Phase 2 — window schema
- Add `initial` and `inverse` to `WindowFunctionSchema` (documented; `bindWindowSchema` preserves them).
- Add the aggregate→window adapter in `builtin-window-functions.ts`; register COUNT/SUM/AVG through it from `countXFunc`/`sumFunc`/`avgFunc`; drop the hand-written ones and the stale NOTE.
- Consume `initial` at all accumulator-start sites in `window.ts`.

Phase 3 — sliding paths
- ROWS: `slidingAcc` becomes the schema accumulator; step/inverse/final through the schema; delete `slidingStepNum`/`slidingUnstepNum`/`slidingFinalAcc`.
- RANGE: generic `slidingScanFold`; delete `slidingScanSum`/`slidingScanCountNonNull` and the empty-frame special case.

Phase 4 — guards, docs, timing
- Add the window↔grouped equivalence spec (registry-driven, all four shapes, storage class compared).
- Update `docs/window-functions.md` (~line 418: accumulator is now the aggregate's own, retracted via its algebra; note window `sum` returns NUMERIC like grouped `sum`).
- Time the large sliding window before/after; record numbers in the review handoff.
- `yarn workspace @quereus/quereus lint` and `yarn test` green.
