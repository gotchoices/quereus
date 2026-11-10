description: A windowed running total over a sliding range of rows can give a different answer from adding up the same rows directly when the column holds decimal values, sometimes dropping whole fractions; the sliding window should give the same total a fresh sum gives.
files:
  - packages/quereus/src/func/builtins/builtin-window-functions.ts  # aggregateWindowParts — derives `inverse` from merge/negate; NOTE describes this
  - packages/quereus/src/func/builtins/aggregate.ts                 # SumAccumulator (exact / approx / count), stepSum, mergeSum, negateSum, finalizeSum
  - packages/quereus/src/runtime/emit/window.ts                     # handleSlidingRowsArrival / finalizeSlidingRowsEntry (step on arrival, inverse on departure), slidingScanFold (refold)
  - packages/quereus/src/schema/window-function.ts                  # WindowFunctionSchema.inverse contract
  - packages/quereus/test/window-aggregate-equivalence.spec.ts      # window ↔ grouped property; its value domain uses only dyadic fractions, so it cannot see this
repro: verified
severity: wrong-result
likelihood: unusual
tradeoffs: Float retraction was explicitly accepted when window sum was rebuilt on the grouped accumulator, SQLite's own sliding sum is also approximate over REAL values, and every correct fix either costs a refold on each slide over a REAL column or changes the shape of sum's accumulator that materialized views persist.
----

# Sliding ROWS `sum`/`avg` drift from a fresh sum over REAL values

## Reproduction (verified 2026-11-10, in-memory `Database`)

```sql
create table r (id integer primary key, v any null);
insert into r values (1, 1e20), (2, 0.5), (3, 5), (4, 7);
select id, sum(v) over (order by id rows between 1 preceding and current row) from r;
select a.id, (select sum(v) from r b where b.id between a.id - 1 and a.id) from r a;
```

| id | window (streaming ROWS sliding) | grouped over the same frame |
|---|---|---|
| 3 | 5 | 5.5 |
| 4 | 11.5 | 12 |

Two separate effects, both in the streaming ROWS sliding path only (RANGE sliding and the buffered frame walk refold each frame and agree with grouped `sum`):

- **Cancellation.** `sum`'s accumulator keeps floating-point contributions in one float total. `1e20 + 0.5` rounds to `1e20`; retracting `1e20` then leaves `0`, so the `0.5` still in the frame is gone (id 3).
- **Residue.** Retracting `0.5` next leaves `-0.5` in the float total even though no float value remains in the frame, so the later all-integer frame `5, 7` finalizes as `11.5` (id 4). With whole numbers past 2^53 the same residue turns an exact `bigint` total into a rounded float (the smaller example `0.1, 0.2, 9007199254740993, 5` shows it: `9007199254740998` as a float instead of `9007199254740998n`).

This predates the rebuild of window sum on the grouped accumulator (the old float `{ sum, count }` sliding accumulator subtracted the same way); it is now the one remaining place where `sum(x) over (…)` and `sum(x)` can disagree. `avg` shares sum's accumulator and inherits both effects.

## Expected behaviour

For every frame, a streaming ROWS sliding `sum`/`avg` returns the same value and storage class as grouped `sum`/`avg` over that frame's rows — the same guarantee `docs/functions.md` (Window Functions) states, minus its current REAL-sliding exception, which should be removed once this is fixed.

## Constraints

- The exact-integer part already retracts exactly; only the floating-point part needs attention.
- `sum`'s accumulator is also what materialized views persist and decode (`algebra.decode` with an absorbing count); a shape change has to keep `aggregate-algebra.spec.ts`'s laws.
- Options seen during review, not chosen: (a) let `inverse` decline when the departing value is a float contribution, and have the ROWS path refold the buffer then (exact, but a refold per slide on REAL columns — the RANGE path already pays this, measured ~25–33% slower end to end at 100-row frames); (b) count floating-point contributions in the accumulator and reset the float total to exactly 0 when that count reaches 0 (fixes the residue, not cancellation); (c) compensated (Neumaier) summation for the float total (reduces both, guarantees neither).
- Once fixed, widen the equivalence spec's value domain to non-dyadic and large-magnitude floats so the property covers this.
