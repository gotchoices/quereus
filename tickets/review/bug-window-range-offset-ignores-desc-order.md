description: A window frame like "rows within 1 of the current row's value" gave the wrong rows when the window was sorted in descending order, because it treated "preceding" as "smaller values". Fixed on both execution paths; this is the review pass.
architecture: docs/window-functions.md
files:
  - packages/quereus/src/runtime/emit/window.ts   # rangeSign / RangeSign / rangeOrdinal (~L724-760); getFrameBounds + rangeOffsetStart/End take `sign`; runStreaming computes `sign` once and signs orderByVal0Num (~L1044, ~L1173)
  - packages/quereus/test/logic/07.5-window.sqllogic   # range_desc + range_null DESC cases, just before the fractional-offset case
  - packages/quereus/test/plan/window-one-sided-frames.spec.ts   # `d` fixture (primary key (id desc)); "a DESC ORDER BY mirrors the offsets" test
  - docs/window-functions.md   # RANGE offset paragraph (~L212)
repro: verified
----
# RANGE `n PRECEDING` / `n FOLLOWING` under a DESC ORDER BY — review

## What changed

Under `order by k desc`, "preceding" means earlier in the sort, i.e. larger values, so `range between n preceding and m following` covers `[v - m, v + n]`. Both physical paths previously did the ascending arithmetic `[v - n, v + m]` regardless of direction (buffered: whole partition or wrong span; streaming: NULL frames).

The fix normalizes the key once per path instead of flipping comparisons: `rangeSign(orderBy)` returns -1 for a DESC leading key, else +1, and every RANGE ordering number is multiplied by it. `sign * v` increases along the sort order in both directions, so the existing ascending scans are correct unchanged. NaN stays NaN, so NULL / non-finite keys still take the peer-group branch.

- Buffered: `processPartition` computes `sign` once and threads it through `computeAggregateFunction` / `computeValueFunction` → `getFrameBounds` → `rangeOffsetStart` / `rangeOffsetEnd` → `rangeOrdinal(value, sign)`. `getFrameBounds`'s three default parameters were made required (no caller used the defaults) so `sign` could be required rather than defaulted.
- Streaming: `runStreaming` computes `sign` once; `orderByVal0Num = sign * Number(orderByLead)`. Checked: `orderByVal0` / `v_j` are only used in range comparisons (`handleSlidingRangeArrival`, `findRangeWindow`, `findNonFinitePeerSpan`, `trimSlidingRangeBuffer`), never emitted.
- Doc comments on `rangeOrdinal`, `SlidingBufEntry.orderByVal0`, `SlidingRangePendingEntry.v_j` and the RANGE strategy block now say the value is signed. `docs/window-functions.md` states both intervals.

## Tests added

- `window-one-sided-frames.spec.ts` — "a DESC ORDER BY mirrors the offsets: n PRECEDING reaches larger keys": over `d` (`primary key (id desc)`), the two-sided (`2 preceding and 1 following`) and trailing (`2 preceding and current row`) frames stream as `slidingAgg`, agree with the buffered walk, and match hand-computed sums. Verified it fails with the sign forced to +1 (streaming vs buffered disagree).
- `07.5-window.sqllogic` — `range_desc` (`count(*) over (order by n desc range between 1 preceding and 1 following)`, the ticket's buffered repro; fails without the fix with `c: 3`), and `range_null` DESC (`10 preceding and current row` over a nullable key: finite rows `[v, v+10]`, NULL rows their peer group). The second pins the asymmetric case on the buffered path with NULLs present; its expected output is ordered by id so it does not depend on where DESC places NULLs.

## Validation

- `yarn workspace @quereus/quereus test` — 11143 passing, 26 pending, 0 failing.
- `yarn workspace @quereus/quereus lint` — clean.

## Known gaps / things to look at

- No streaming DESC case with NULL keys: the memory module only advertises DESC monotonic order for a non-nullable leading column, so it is not reachable today. If that changes, the streaming buffer's assumption that non-finite rows cluster at one edge still holds (NULLs sort as a block either way), but no test covers it.
- No test of `n FOLLOWING` as a start bound or `n PRECEDING` as an end bound under DESC (buffered only; those shapes do not stream). The sign normalization covers them by the same arithmetic, but they are unpinned.
- Multi-key ORDER BY is rejected for RANGE offsets at prepare time, so only `orderBy[0]`'s direction matters; `rangeSign` reads only that.
