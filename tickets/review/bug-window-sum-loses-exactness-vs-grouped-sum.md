---
description: Windowed sums and averages of very large whole numbers now give the same exact answer as a plain sum or average, and plain average now agrees with how materialized views compute it; review the change and two remaining edge cases found along the way.
files:
  - packages/quereus/src/func/builtins/aggregate.ts                 # sum's step/merge/negate/finalize named; avgFunc rebuilt on them; avgQuotient shared with decompose.combine
  - packages/quereus/src/func/builtins/builtin-window-functions.ts  # aggregateWindowParts + registerAggregateAsWindowFunction; hand-written COUNT/SUM/AVG and stale NOTE removed
  - packages/quereus/src/schema/window-function.ts                  # WindowFunctionSchema.initial / .inverse; WindowFunctionBinding.inverse; bindWindowSchema inverse rule
  - packages/quereus/src/runtime/emit/window.ts                     # initialAccumulator/finalizeAccumulator; ROWS sliding via step/inverse/final; slidingScanFold/slidingScanValue; EMPTY_SLICE
  - packages/quereus/test/window-aggregate-equivalence.spec.ts      # NEW — registry-driven window↔grouped equivalence
  - packages/quereus/test/incremental/aggregate-algebra.spec.ts     # avg law check over sumDomain
  - packages/quereus/test/planner/window-function-types.spec.ts     # window sum now announces NUMERIC
  - docs/window-functions.md                                        # sliding state machine, "Aggregates as window functions", bindArgs inverse rule
  - docs/functions.md                                               # avg accumulation sentence; window-capable aggregate list corrected
repro: verified
---

# Window `sum`/`avg` and grouped `avg` keep exactness on large whole numbers

## What changed

- **`avg` accumulates as `sum` does.** `avgFunc` now uses sum's own accumulator (exact-integer part + floating-point part + count), step, merge and negate, and divides only at finalize. `finalize` and `decompose.combine` call one helper, `avgQuotient(sumTotal, count)`, so direct avg and the sum/count decomposition cannot drift. Side effect: avg's handling of non-numeric inputs is now sum's (text via `parseNumericText`, booleans 1/0, blobs/JSON and non-numeric text skipped).
- **Window COUNT/SUM/AVG are derived from the grouped aggregates.** `registerAggregateAsWindowFunction(aggSchema)` builds the window schema from `countXFunc`/`sumFunc`/`avgFunc`: same `stepFunction`, `finalizeFunction`, `initialValue` (as `initial`), `returnType`, `inferReturnType`, and `bindArgs` (mapped through `bindAggregateSchema`; none of the three uses it today). Window `sum` therefore announces NUMERIC (was REAL). MIN/MAX untouched, as the ticket said.
- **`WindowFunctionSchema` gained `initial` and `inverse`.** `inverse = merge(state, negate(step(initial, value)))` when the algebra declares both. `bindWindowSchema` keeps `inverse` unless a binding replaces `step` without supplying its own `inverse`; in that case it drops it, so the sliding path refolds the frame, which is always correct. `WindowFunctionBinding` gained `inverse`.
- **Runtime (`window.ts`)**: every accumulator-start site (buffered frame walk, running aggregate, ROWS sliding) starts from `schema.initial()`. ROWS sliding keeps the schema accumulator and steps/inverts/finalizes through the schema when `inverse` exists, else refolds the buffer. RANGE sliding and the no-inverse ROWS case go through one `slidingScanFold`; an empty slice finalizes the fresh accumulator (0 for count, NULL otherwise), which replaced the hard-coded `count ? 0 : null`. `slidingStepNum`/`slidingUnstepNum`/`slidingFinalAcc`/`slidingScanSum`/`slidingScanCountNonNull`/`slidingScanExtremum` are gone; `window.ts` no longer does arithmetic on argument values.

## Verified behaviour (ran it)

Table `w(id integer primary key, v integer)` = `(1, 9007199254740993), (2, 5), (3, 7)`:

| query | result now |
|---|---|
| `sum(v)` | 9007199254741005n |
| `sum(v) over ()` | 9007199254741005n ×3 |
| `sum(v) over (order by id)` | …0993n, …0998n, …1005n |
| `rows between 1 preceding and current row` | …0993n, …0998n, 12 |
| `range between 1 preceding and 1 following` | …0998n, …1005n, 12 |
| `rows between unbounded preceding and unbounded following` | …1005n ×3 |

Text column `'9007199254740993', '1'`: `sum(v)` and `sum(v) over ()` both 9007199254740994n; `avg(v)` and `avg(v) over ()` both 4503599627370497.

## Tests

- `test/window-aggregate-equivalence.spec.ts` (new):
  - *covers the registry aggregates on the intended execution shapes*: the registry-driven list includes count/sum/avg/min/max, and each ordered shape really plans `runningAgg`/`slidingAgg` streaming (`over ()` stays buffered). Without it the property below could silently run on the buffered walk only.
  - *every shape matches the grouped aggregate over the same frame, storage class included*: fast-check, 50 runs (~2.4 s). Domain: NULL, bigints past 2^53, safe integers within 1000 of the boundary, dyadic fractions, and numeric text of each. Shapes: `over ()`, running, `rows between 2 preceding and 1 following`, `range between 2 preceding and 1 following`. Grouped side is a correlated `(select f(b.v) from w b where <frame>)`. It found no float-retraction divergence over this domain. I did not run it against the old code; by inspection, old window SUM returned `number` for a bigint input, so it fails at the first bigint value.
- `test/incremental/aggregate-algebra.spec.ts`: avg's law check now runs over `sumDomain` (the arm-2 reproduction: decomposition law over large whole numbers). The `intOrNull` comment no longer justifies itself with "avg sums as floats".
- `test/planner/window-function-types.spec.ts`: two assertions changed REAL → NUMERIC for window `sum` (intended type change).
- No sqllogic case added; the spec expresses storage class directly.

Validation run: `yarn workspace @quereus/quereus test` (11141 passing, 26 pending), `yarn workspace @quereus/quereus lint` clean, root `yarn test` green across all workspaces.

## Performance (decision asked for a timing)

Throwaway script, 200k rows `v = (id*7919) % 100003`, in-memory, streaming plan confirmed. I extracted HEAD's `src` from git and A/B'd it against the new code twice, 5 iterations per query, medians:

| query | before | after |
|---|---|---|
| ROWS sliding sum, `rows between 100 preceding and current row` | 1259–1563 ms | 1362–1467 ms |
| ROWS sliding avg, same frame | 1265–1657 ms | 1428–1476 ms |
| RANGE sliding sum, `range between 100 preceding and current row` | 1347–1462 ms | 1780–1796 ms |
| running sum, `over (order by id)` | 1309–1605 ms | 1344–1406 ms |

ROWS sliding and running are within run-to-run noise. RANGE sliding is about 25–33% slower end to end: it refolds ~101 rows per output row, and sum's immutable step allocates an accumulator per row. I parked this as a `NOTE:` at `slidingScanFold` (`window.ts`). The follow-ups that NOTE names are sliding RANGE through `inverse` or adding a mutable fold in `aggregate.ts`, not a float copy.

## Findings for the reviewer (both verified by running; neither fixed here)

1. **Float residue under ROWS retraction can turn a later exact total into a float.** Sum's floating-point part retracts in float, as the decision accepted. But an inexact retraction (0.1 + 0.2 − 0.1 − 0.2 ≈ 2.8e-17) leaves a residue for the rest of the partition. Repro: `any` column rows `0.1, 0.2, 9007199254740993, 5`, `sum(v) over (order by id rows between 1 preceding and current row)`. At id 4 it returns `9007199254740998` (number), while `select sum(v) from r where id between 3 and 4` returns `9007199254740998n`. An odd total there would also lose its last digit. Before this ticket every window sum was float, so this is not a regression, but it is reachable now with unusual data (fractions and >2^53 integers in one column). Parked as a `NOTE:` on `aggregateWindowParts` (`builtin-window-functions.ts`). The fix I'd propose: give `SumAccumulator` a count of floating-point contributions and reset `approx` to exactly 0 when that count reaches 0. That changes the grouped accumulator's shape (and the deep-equal pins in `aggregate-algebra.spec.ts`), so it's a separate decision: file as `bug-` or accept.
2. **avg's decomposition divisor counts values sum skips.** The ticket predicted this; I confirmed it at the SQL level. With `m(id, g, v any)` = `(1,1,'abc'), (2,1,4), (3,2,6)` and a materialized view storing `sum(v), count(v), count(*) group by g`, `select avg(v) from m` is rewritten to the view rollup and returns 3.333… (10/3). Evaluated directly it is 5, because `count(x)` counts `'abc'` and sum/avg skip it. Predates this ticket (the old float avg also skipped `'abc'`). Parked as a `NOTE:` on avg's `decompose` in `aggregate.ts`. The fix (a count partial that skips what sum skips, or a different skip rule) is a separate decision.

## Things worth a second look

- `bindWindowSchema`'s inverse rule (`bound.step ? bound.inverse : (bound.inverse ?? schema.inverse)`) is new contract surface; documented in `docs/window-functions.md` and on `WindowFunctionBinding`.
- The adapter's `bindArgs` pass-through is untested (no current aggregate behind it has `bindArgs`). It exists so a future `sumFunc.bindArgs` reaches the window without anyone mirroring it.
- avg over booleans/blobs now follows sum's coercion rules rather than `Number()`; no logic test changed, but reviewers may want to confirm that's the intended semantics.
