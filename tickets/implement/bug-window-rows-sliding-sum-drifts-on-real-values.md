description: A windowed running total over a sliding range of rows can give a different answer from adding up the same rows directly when the column holds decimal values, sometimes dropping whole fractions or turning an all-integer total into a decimal; make sum's running total compensate for rounding and forget decimal leftovers once no decimal value remains.
architecture: docs/functions.md#window-functions
files:
  - packages/quereus/src/func/builtins/aggregate.ts                 # SumAccumulator, addSumContribution, stepSum, mergeSum, negateSum, finalizeSum, sumFunc.algebra.decode — the whole change lives here
  - packages/quereus/src/func/builtins/builtin-window-functions.ts  # aggregateWindowParts — its NOTE describing the drift must be rewritten (inverse derivation itself stays)
  - packages/quereus/src/runtime/emit/window.ts                     # handleSlidingRowsArrival / finalizeSlidingRowsEntry — the affected path; no change expected
  - packages/quereus/test/window-aggregate-equivalence.spec.ts      # widen value domain; tolerance for REAL frames
  - packages/quereus/test/incremental/aggregate-algebra.spec.ts     # deep.equal accumulator-shape expectations (~lines 174–197, 244) must gain the new fields
  - docs/functions.md                                               # Window Functions paragraph (~line 216): replace the REAL-sliding exception
repro: verified
----

# Sliding ROWS `sum`/`avg` drift from a fresh sum over REAL values

## Reproduction (verified 2026-11-10 against current source)

```sql
create table r (id integer primary key, v any null);
insert into r values (1, 1e20), (2, 0.5), (3, 5), (4, 7);
select id, sum(v) over (order by id rows between 1 preceding and current row) from r;
-- id 3 → 5   (grouped over the same frame: 5.5)
-- id 4 → 11.5 (grouped: 12)
```

The streaming ROWS sliding path (`runtime/emit/window.ts`) steps arriving rows and retracts departing rows through `inverse = merge(state, negate(step(identity, value)))` (`aggregateWindowParts`). `sum`'s accumulator (`SumAccumulator` in `aggregate.ts`) is `{ exact, approx, count }`: integers/booleans go to `exact` (exact, bigint past 2^53), everything else (fractions, unsafe whole numbers, ±Infinity, NaN) to the plain float `approx`. Two defects:

- **Cancellation** (id 3): `1e20 + 0.5` rounds to `1e20` in `approx`; retracting `1e20` leaves `0`, so the `0.5` still in the frame is lost.
- **Residue** (id 4): retracting `0.5` next leaves `-0.5` in `approx` with no REAL value left in the frame, so `finalizeSum`'s `approx === 0` test fails and the all-integer frame `5, 7` finalizes as `11.5`. With whole numbers past 2^53 the same residue turns an exact `bigint` total into a float (`0.1, 0.2, 9007199254740993, 5` with a 2-row frame gives `9007199254740998` as a float instead of `9007199254740998n`).

`avg` uses the same accumulator, step, merge and negate, so it inherits both and is fixed by the same change. RANGE sliding and the buffered frame walk refold each frame and are already correct.

## Decided semantics (maintainer, 2026-11-10) — no refold per slide

Applies to every path: grouped, window, sliding, materialized rollup.

- Integer and boolean contributions are exact, past 2^53 included.
- REAL contributions are approximate: a window result may differ from grouped `sum` in the last digits, since the order of additions is not specified.
- The storage class follows the frame's current contents: a frame holding no REAL value finalizes as an integer (`bigint` past the safe range), never a float. Conversely a fold that holds a REAL value finalizes as a float even when the REAL parts cancel to 0 — e.g. grouped `sum` over `9007199254740993, 0.5, -0.5` becomes a float, where today it returns the `bigint` because `approx === 0`. This matches SQLite (REAL result whenever a REAL was summed). Watch for sqllogic expectations that relied on the old behaviour.

## Design

Extend the non-null accumulator to:

```ts
type SumAccumulator = {
	exact: number | bigint;   // unchanged
	approx: number;           // float running total of REAL contributions
	comp: number;             // Neumaier compensation term for approx
	realCount: number;        // count of REAL (approx-routed) contributions currently held
	count: number;            // unchanged: all non-NULL contributions
} | null;
```

- **Step** (`addSumContribution`): exact-domain values as today (`realCount` unchanged). A REAL value is added to `approx` with Neumaier two-sum (`t = s + v; comp += |s| >= |v| ? (s - t) + v : (v - t) + s; s = t`) and `realCount + 1`.
- **Merge**: exact parts as today; `approx` parts combined by the same Neumaier two-sum, `comp = a.comp + b.comp + error`; `realCount` and `count` add. If the merged `realCount === 0`, reset `approx` and `comp` to exactly 0 — this is the residue fix, and it is what the sliding inverse hits when the last REAL value leaves.
- **Negate**: negate every field, `realCount` included.
- **Finalize**: `count === 0` → NULL as today. `realCount === 0` → return `exact` untouched (replaces the `approx === 0` test). Otherwise `Number(exact) + (approx + comp)`.
- **Non-finite values**: when the two-sum result `t` is not finite, the compensation formula yields NaN (`Infinity - Infinity`); skip the compensation update then, and in finalize use `approx` alone when it is non-finite, so a fold holding `Infinity` still finalizes `Infinity` as grouped `sum` does today. Retracting an infinity from a sliding frame leaves `approx` as NaN while other REAL values remain — this is pre-existing and not covered by the decision; either keep separate counts of `+Infinity`/`-Infinity`/NaN contributions outside `approx` if that stays small, or leave a `NOTE:` at the site and file a `bug-` in backlog. Say which in the review handoff.
- **Decode** (materialized views store only the finalized value): an exact-domain stored value → `{ exact: v, approx: 0, comp: 0, realCount: 0, count: Infinity }`; a float stored value → `{ exact: 0, approx: v, comp: 0, realCount: Infinity, count: Infinity }` — `realCount` absorbing for the same reason `count` is (a finite retraction must not reset the float part of a total whose REAL contributions are unknown). The new fields are in-memory only; nothing persisted changes shape. The delta-maintenance gate that refuses REAL arguments (`core/database-materialized-views-plan-builders.ts`) stays as is.
- Rewrite the `approx` field NOTE ("plain IEEE-754 accumulation, NOT compensated") to describe the compensated sum and the realCount reset; keep its point that the delta gate still refuses REAL arguments (compensation reduces rounding error, it does not make REAL retraction exact).

`aggregate-algebra.spec.ts`'s laws compare finalized values (`sqlValueIdentical` after finalize) over dyadic fractions, where two-sum error is always 0, so they should keep passing; only the literal `deep.equal` accumulator shapes need the new fields.

## TODO

- Implement the accumulator change in `packages/quereus/src/func/builtins/aggregate.ts` (step, merge, negate, finalize, decode, non-finite guard) and rewrite its NOTE comments.
- Rewrite the NOTE on `aggregateWindowParts` in `builtin-window-functions.ts` to state the decided semantics (exact integers, approximate REAL, storage class follows frame contents) instead of the drift.
- Update the shape expectations in `test/incremental/aggregate-algebra.spec.ts`; confirm the law suite passes unchanged otherwise.
- Widen `test/window-aggregate-equivalence.spec.ts`'s `valueArb` with non-dyadic fractions (e.g. `fc.double` in a moderate range) and large/small-magnitude REALs (e.g. ±1e15..1e20 and 1e-10 scale), keeping the existing exact arms. Compare exactly (value and storage class) when the frame holds no REAL value and for count/min/max always; for `sum`/`avg` frames holding a REAL, require the same storage class and `|window - grouped| <= ~1e-12 · Σ|v|` where the sum of absolute values is taken over the whole partition (retraction error accumulates across the partition, not just the frame). Rewrite the spec's header comment, which currently explains why fractions are dyadic.
- Add the repro as a pinned case (in the equivalence spec or a small sqllogic file under `test/logic/`): ROWS 1-preceding frame over `1e20, 0.5, 5, 7` → `…, 5.5, 12`, and `0.1, 0.2, 9007199254740993, 5` → last row `9007199254740998n` (bigint).
- Replace the REAL-sliding exception in `docs/functions.md` (Window Functions, ~line 216) with the semantics above.
- Run `yarn workspace @quereus/quereus test` and `yarn workspace @quereus/quereus lint`; check for sqllogic expectations affected by the storage-class change (REAL values that cancel to 0 now finalize as float).
