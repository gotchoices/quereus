description: A windowed running total over a sliding range of rows could give a different answer from adding up the same rows directly when the column holds decimal values, sometimes dropping whole fractions or turning an all-integer total into a decimal. Sum's running total now compensates for rounding and forgets decimal leftovers once no decimal value remains in the frame.
architecture: docs/functions.md#window-functions
files:
  - packages/quereus/src/func/builtins/aggregate.ts                 # SumAccumulator (+comp, +realCount), additionError, addSumContribution, mergeSum, negateSum, finalizeSum, sum decode
  - packages/quereus/src/func/builtins/builtin-window-functions.ts  # aggregateWindowParts NOTE rewritten (code unchanged)
  - packages/quereus/test/window-aggregate-equivalence.spec.ts      # widened value domain, tolerance, pinned slide cases
  - packages/quereus/test/incremental/aggregate-algebra.spec.ts     # accumulator-shape expectations gained comp/realCount
  - packages/quereus/test/logic/07.5-sum-mixed-exact-and-float.sqllogic  # section 5: compensation + cancel-to-0 storage class
  - docs/functions.md                                               # sum paragraph + Window Functions paragraph
repro: verified
----

# Review: sliding ROWS `sum`/`avg` over REAL values

## What changed

`sum`'s accumulator (shared by `avg`) is now `{ exact, approx, comp, realCount, count }`:

- **Compensation.** REAL contributions (anything not a `bigint` or safe integer) are added to `approx` with Neumaier two-sum; the rounding error goes to `comp`. `additionError(a, b, sum)` computes the error term without allocating and returns 0 when `sum` is non-finite (the formula would produce NaN). Step and merge both use it; merge sums `a.comp + b.comp + error`.
- **`realCount`.** Counts REAL contributions currently held. Step increments it for a REAL value, merge adds, negate negates. When a merge brings it to 0 (a sliding frame retracts its last REAL value), `approx` and `comp` reset to exactly 0. This removes leftover rounding, and also clears NaN/Infinity left by retracting an infinity.
- **Finalize.** `count === 0` → NULL (unchanged). `realCount === 0` → `exact` untouched (replaces the old `approx === 0` test). Otherwise `Number(exact) + (approx + comp)`, or `+ approx` alone when `approx` is non-finite.
- **Decode.** An exact stored value decodes with `realCount: 0`. A float stored value decodes with `realCount: Infinity`, which a finite retraction cannot bring to 0, for the same reason `count` uses Infinity. In-memory only; nothing persisted changes shape. The delta-maintenance gate that refuses REAL arguments is untouched, and the `approx` NOTE still says why.

**Behaviour change (maintainer decision):** a fold holding a REAL value finalizes as a float even when the REAL values cancel to 0. Grouped `sum(9007199254740993, 0.5, -0.5)` used to return the `bigint` 9007199254740993 and now returns the float 9007199254740992. This matches SQLite and the existing wording in docs/functions.md. The full suite found no other sqllogic expectation that relied on the old behaviour.

## Tests (each checked by breaking the code on purpose)

- `window-aggregate-equivalence.spec.ts`, property test: the value domain adds arbitrary doubles (±1e6), large REALs (±1e15..1e20) and small REALs (±1e-11..1e-9). Shapes gained a JS `inFrame` predicate matching their SQL frame. The comparison is exact (value and storage class) for count/min/max always, and for sum/avg when the frame holds no REAL value. A sum/avg frame holding a REAL must have the same storage class and agree within `1e-12·Σ|v|frame + 1e-24·Σ|v|partition`. **This deviates from the ticket's suggested `1e-12·Σ|v|partition`**: that bound is one uncompensated retraction already meets, and with it the property test passed with compensation disabled. Compensated error is first-order only in the frame's own magnitude, with a second-order term across the partition, so the tighter bound fails with compensation disabled and passed 1000 runs (`numRuns` raised temporarily) with it enabled. The in-tree run stays at 50, about 5–7 s.
- Same spec, new pinned test `a ROWS frame sliding past a large or REAL value…` (1-preceding frame):
  - `1e20, 0.5, 5, 7` → `1e20, 1e20, 5.5, 12`: the compensation and the no-residue rule.
  - `0.1, 0.2, 9007199254740993n, 5` → last row `9007199254740998n`: the frame becomes a `bigint` again.
  - `Infinity, 5, 7, 0.5` → last row `7.5`: the merge reset. This case is the only test that fails without the reset. Finalize already keys on `realCount`, and compensation keeps finite leftovers inside the rounding bound, so nothing else sees the reset.
- `07.5-sum-mixed-exact-and-float.sqllogic` section 5: the old "all-float fold is bit-identical to `0.1 + 0.2`" case is gone. That identity is no longer promised; it still held only because 0.1 + 0.2 is a rounding tie. In its place: grouped compensation (`1e20, 0.5, -1e20` → 0.5), and the cancel-to-0 storage-class rule (`9007199254740993, 0.5, -0.5` → 9007199254740992). That second case fails if finalize goes back to the `approx === 0` test.
- `aggregate-algebra.spec.ts`: the `deep.equal` shape literals gained the two fields. The law suite passes unchanged; its fractions are dyadic, so two-sum error is always 0 there.

Validation run: `yarn workspace @quereus/quereus test`: 11144 passing, 26 pending, 0 failing. `yarn workspace @quereus/quereus lint` exits 0.

## Known gaps / for the reviewer

- **Non-finite values in sliding frames: not fixed.** Retracting an infinity leaves NaN, and retracting one addend of an overflowed total leaves Infinity. Either stays wrong while any REAL value remains in the frame. Verified, and filed as `backlog/bug-sliding-window-sum-poisoned-by-non-finite-real`, with a NOTE at `finalizeSum`. Counting infinities separately, as the ticket suggested, would fix only the explicit-infinity case, not overflow. So I filed both cases together rather than shipping half of the fix.
- `total()` still uses plain float addition, so grouped `sum` and `total` over REAL values can now differ in the last digits. Nothing in the docs or tests promises they agree for finite values; the existing pin covers only the non-finite case, which is unchanged.
- The spec's tolerance constants (`1e-12`, `1e-24`) come from the standard Neumaier error bound with plenty of margin (about 10^4 ulps first-order, about 10^6 times the expected second-order term). If the property test ever flakes on a sum/avg tolerance miss, check this reasoning before loosening the bound. Loosening it to scale with the partition's magnitude stops the test from checking compensation.
- Hot-path cost: every REAL step now does one extra `Math.abs` comparison, a few float operations, and builds a five-field object instead of three. Not benchmarked.
