description: A windowed running total over a sliding range of rows could give a different answer from adding up the same rows directly when the column holds decimal values, sometimes dropping whole fractions or turning an all-integer total into a decimal. Sum's running total now compensates for rounding and forgets decimal leftovers once no decimal value remains in the frame.
architecture: docs/functions.md#window-functions
files:
  - packages/quereus/src/func/builtins/aggregate.ts                 # SumAccumulator (+comp, +realCount), additionError, addSumContribution, mergeSum, negateSum, finalizeSum, sum decode
  - packages/quereus/src/func/builtins/builtin-window-functions.ts  # aggregateWindowParts NOTE rewritten (code unchanged)
  - packages/quereus/test/window-aggregate-equivalence.spec.ts      # widened value domain, tolerance, pinned slide cases
  - packages/quereus/test/incremental/aggregate-algebra.spec.ts     # accumulator-shape expectations gained comp/realCount
  - packages/quereus/test/logic/07.5-sum-mixed-exact-and-float.sqllogic  # section 5: compensation + cancel-to-0 storage class
  - docs/functions.md                                               # sum paragraph + Window Functions paragraph
  - docs/aggregate-algebra.md                                       # accumulator shape (review)
  - docs/mv-maintenance.md                                          # float-exact tripwire (review)
repro: verified
----

# Sliding ROWS `sum`/`avg` over REAL values

## What shipped

`sum`'s accumulator (shared by `avg`) is now `{ exact, approx, comp, realCount, count }`.

- REAL contributions go into `approx` with Neumaier compensated summation; `comp` holds the rounding error. Step and merge both use `additionError`, which returns 0 for a non-finite sum.
- `realCount` counts the REAL contributions held. When a merge (a sliding frame's retraction) brings it to 0, `approx` and `comp` reset to 0, which removes rounding residue and any NaN/Infinity left by retracting an infinity.
- Finalize keys the storage class on `realCount === 0` rather than `approx === 0`. **Behaviour change:** a fold holding a REAL value is REAL even when the REAL values cancel to 0 (grouped `sum(9007199254740993, 0.5, -0.5)` → float 9007199254740992), as in SQLite.
- A float value stored by a materialized view decodes with `realCount: Infinity`, so a retraction can't take it to 0. The delta-maintenance gate that refuses REAL arguments is unchanged.

Tests: the window/grouped equivalence property test now generates arbitrary, large and small REALs and checks them against a rounding bound tight enough to fail without compensation. There is a pinned slide test for the 1e20/0.5 case, the case where the frame turns back into a `bigint`, and the Infinity-reset case. sqllogic section 5 pins compensation and the cancel-to-0 storage class.

Known follow-up: `backlog/bug-sliding-window-sum-poisoned-by-non-finite-real`. A frame still holding REAL values after an infinity, or after one addend of an overflowed total, has left returns NaN/Infinity.

## Review findings

Read `ticket(implement): bug-window-rows-sliding-sum-drifts-on-real-values` first, then the handoff.

- **Correctness (checked, no defect).** Went through step, merge, negate, finalize and decode for both the grouped and the window-retraction paths (`aggregateWindowParts` builds the inverse as `merge(state, negate(step(identity, v)))`). The `realCount === 0` reset only fires when no REAL contribution is held, so it discards nothing real. Paths where `realCount` could go negative or turn NaN (retracting a decoded float, or a REAL retracted against an exact decode) can't happen while the delta gate refuses REAL arguments, and `count` already behaves the same way there. A scratch probe of other frames gave the grouped results: `unbounded preceding`, `1 preceding and 1 following`, `current row and unbounded following`, a NULL inside the frame, a REAL leaving next to a `bigint` past 2^53, and running `0.1`×10 (now 1 exactly). The probe was deleted.
- **Performance (fixed).** The integer step in `addSumContribution` built its result with `{ ...base, … }`. Integer `sum` is the most common path. A node micro-benchmark (2e7 steps, same shape) measured an object literal at about 110 ms against 150–185 ms for the spread, so the step now uses an explicit five-field literal. The REAL step's extra float work was not benchmarked; it is a few float operations per REAL row.
- **Docs (fixed).** `docs/aggregate-algebra.md` still described the accumulator as `{exact, approx, count}` and the decode without `realCount`. Both are updated, and the doc now explains that finalize keys on `realCount` and that merge resets the float part. The float-exact tripwire in `docs/mv-maintenance.md` said a REAL fast path "needs compensated (Kahan) accumulation", but that is now in place and still isn't enough. It now says compensation is present, doesn't make retraction exact, and that the real blocker is the single stored value per group. `docs/functions.md` and the code NOTEs were already accurate.
- **Tests (kept as is).** The property test's tolerance deviates from the fix ticket's suggested bound. The handoff explains why: the suggested bound is weak enough to pass with compensation disabled. I accept that reasoning. Each pinned case covers a separate branch (compensation, return to `bigint`, the Infinity reset), and the handoff reports breaking each branch on purpose to confirm the test catches it. The `aggregate-algebra.spec.ts` changes only update the expected accumulator shape. I cut no tests and added none, since no new defect needed one.
- **Non-finite retraction.** Already filed by the implementer as `backlog/bug-sliding-window-sum-poisoned-by-non-finite-real`, which has severity, likelihood and tradeoffs, plus a NOTE at `finalizeSum`. Nothing more to do.
- **`total()` vs `sum` over REAL values.** These can now differ in the last digits. Nothing in the docs or tests promises they agree for finite values, and the non-finite pin is unchanged. Accepted as the handoff describes; no ticket.
- **Error handling / resource cleanup / type safety.** Nothing applies: the change is pure arithmetic with no I/O or resources, and lint (eslint plus a type check of the test files) passes.

Validation: `yarn workspace @quereus/quereus lint` exits 0; `yarn workspace @quereus/quereus test` gives 11144 passing, 26 pending, 0 failing.
