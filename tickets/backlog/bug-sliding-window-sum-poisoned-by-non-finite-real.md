description: A windowed sum or average over a sliding range of rows returns NaN or Infinity for frames that hold only ordinary numbers, after an infinite value, or a pair of values whose total overflowed, has left the frame. The wrong answer persists until the frame holds no decimal value at all.
architecture: docs/functions.md#window-functions
files:
  - packages/quereus/src/func/builtins/aggregate.ts                 # SumAccumulator, addSumContribution, mergeSum, finalizeSum — NOTE at finalizeSum marks the site
  - packages/quereus/src/func/builtins/builtin-window-functions.ts  # aggregateWindowParts — the retraction is merge(state, negate(step(identity, value)))
  - packages/quereus/test/window-aggregate-equivalence.spec.ts      # value domain excludes non-finite values today
repro: verified
severity: wrong-result
likelihood: contrived
tradeoffs: Needs an infinite value stored in a column, or REAL values near 1e308 adding past the largest finite number, inside a sliding ROWS frame. Fixing the overflow arm needs either a wider representation for sum's floating-point running total or a refold fallback, both of which cost complexity on a hot path for data almost nobody has.
----

# Sliding ROWS `sum`/`avg` cannot retract a non-finite floating-point total

`sum`'s accumulator keeps REAL (non-integer) contributions in one float running total, `approx`, with a Neumaier compensation term. A streaming `rows between …` window frame removes a departing row by adding its negation. That cannot undo a non-finite total:

- **An infinite value leaves the frame.** `Infinity + -Infinity` is NaN, so the frame finalizes NaN while it still holds other REAL values.
- **Finite values overflowed.** `1e308 + 1e308` is `Infinity`; retracting one `1e308` leaves `Infinity`, not `1e308`.

Grouped `sum` over the same rows is correct. Once the frame holds no REAL value, `mergeSum` resets the float part (sum's `realCount` reaches 0), so the wrong answers stop there.

## Reproduction (verified 2026-11-10)

```sql
create table r (id integer primary key, v any null);
-- (bind values as parameters: Infinity has no SQL literal)
insert into r values (1, ?), (2, ?), (3, ?), (4, ?);   -- Infinity, 0.5, 0.25, 5
select id, sum(v) over (order by id rows between 1 preceding and current row) from r;
-- window:  Infinity, Infinity, NaN, NaN
-- grouped: Infinity, Infinity, 0.75, 5.25

-- values 1e308, 1e308, 0.5, 0.25
-- window:  1e308, Infinity, Infinity, Infinity
-- grouped: 1e308, Infinity, 1e308,    0.75
```

`avg` shares the accumulator and has the same problem.

## Expected behaviour

A sliding frame's `sum`/`avg` agrees with grouped `sum`/`avg` over the same rows when non-finite values or overflow are involved, within the existing rule that REAL results may differ in the last digits. Grouped `sum` today returns `Infinity`, `-Infinity`, or NaN (for both infinities, or a NaN contribution) and is the reference.

Possible directions (not a plan): count `+Infinity`, `-Infinity` and NaN contributions outside `approx` and derive the non-finite part at finalize, which fixes the first arm and also makes grouped `sum` independent of row order when overflow meets an explicit infinity (inferred from IEEE arithmetic, not run: `1e308, 1e308, -Infinity` gives NaN but `1e308, -Infinity, 1e308` gives `-Infinity`). The overflow arm needs more: a running total with wider range than one double, or the window emitter refolding the frame when the total turns non-finite. Whatever the fix, the window equivalence property test's value domain should gain non-finite values and values near the overflow boundary.
