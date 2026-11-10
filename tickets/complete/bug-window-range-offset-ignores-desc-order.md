description: A window frame like "rows within 1 of the current row's value" gave the wrong rows when the window was sorted in descending order, because it treated "preceding" as "smaller values". Fixed on both execution paths and reviewed.
architecture: docs/window-functions.md
files:
  - packages/quereus/src/runtime/emit/window.ts   # rangeSign / RangeSign / rangeOrdinal; getFrameBounds + rangeOffsetStart/End take `sign`; runStreaming signs orderByVal0Num
  - packages/quereus/test/logic/07.5-window.sqllogic   # range_desc + range_null DESC cases
  - packages/quereus/test/plan/window-one-sided-frames.spec.ts   # `d` fixture (primary key (id desc)); "a DESC ORDER BY mirrors the offsets" test
  - docs/window-functions.md   # RANGE offset paragraph
repro: verified
----
# RANGE `n PRECEDING` / `n FOLLOWING` under a DESC ORDER BY

## What was wrong

Under `order by k desc`, "preceding" means earlier in the sort, which is larger values, so `range between n preceding and m following` covers `[v - m, v + n]`. Both physical paths did the ascending arithmetic `[v - n, v + m]` whatever the direction. The buffered path returned the whole partition or the wrong span. The streaming path returned NULL frames.

## Fix

`rangeSign(orderBy)` returns -1 when the leading ORDER BY key is DESC and +1 otherwise. Every RANGE ordering number is multiplied by it, so `sign * v` increases along the sort order in both directions and the existing ascending scans are correct without changes. NaN stays NaN, so NULL keys still take the peer-group branch.

- Buffered path: `processPartition` computes `sign` once and passes it through `computeAggregateFunction` / `computeValueFunction` → `getFrameBounds` → `rangeOffsetStart` / `rangeOffsetEnd` → `rangeOrdinal(value, sign)`. `getFrameBounds` no longer has default parameters.
- Streaming path: `runStreaming` computes `sign` once, and `orderByVal0Num = sign * Number(orderByLead)`. The signed value is only used in RANGE comparisons and is never emitted.
- `docs/window-functions.md` gives both intervals.

Tests: the spec "a DESC ORDER BY mirrors the offsets" checks that a two-sided frame and a trailing frame both stream, agree with the buffered walk, and match hand-computed sums. The sqllogic `range_desc` case is the original buffered repro. The `range_null` DESC case covers an asymmetric frame over a nullable key.

## Review findings

Checked:
- **Implement diff** (`ticket(implement): bug-window-range-offset-ignores-desc-order`), read before the handoff. The emitter reads DESC as `orderBy[0]?.direction === 'desc'`, the same way `rule-monotonic-window.ts` chooses the streaming direction and `window-node.ts` builds sort keys, so the planner and the emitter agree.
- **Streaming invariants**: `handleSlidingRangeArrival`, `findRangeWindow`, `findNonFinitePeerSpan` and `trimSlidingRangeBuffer` all assume `orderByVal0` ascends in arrival order. That holds once the value is signed. `m.preceding` / `m.following` come from the raw frame literals and need no sign, because the sign is applied to the key, not to the offsets.
- **Edge values**: `sign * 0 = -0` compares like 0. A bigint is converted to a number before the sign is applied, as before. A non-numeric key is unchanged (rejected when the statement is prepared).
- **Untested shapes**: I ran ad-hoc queries, not kept, on a nullable integer key under DESC: `range between 1 following and 3 following` (start bound `n FOLLOWING`), `range between 3 preceding and 1 preceding` (end bound `n PRECEDING`), and `nulls first` with `1 preceding and 1 following`. All matched hand-computed frames, including empty frames (NULL sum) and the NULL peer group. I added no test for these: they use the same signed arithmetic as the cases already pinned, and the `range_null` DESC case already covers an asymmetric frame.
- **Tests under review**: kept all three. The spec test pins the streaming-vs-buffered agreement. `range_desc` is the repro at the sqllogic layer, which `yarn test:store` also runs against the store module. The `range_null` DESC case is the only DESC case with NULLs. Some overlap with the spec's buffered half, but each case is small and serves a separate purpose.
- **Docs**: `docs/window-functions.md` states both intervals. The other mentions of `[v - n, v + m]` (the NULL paragraph) and the streaming table are still correct.
- **Hygiene**: the doc comments on `rangeOrdinal`, `SlidingBufEntry.orderByVal0`, `SlidingRangePendingEntry.v_j` and the RANGE strategy block now say the value is signed. No comments that just narrate the code; no file-size concern from this diff.

Found:
- Major: none.
- Minor: none needed fixing.
- Tripwire: streaming DESC over a nullable key cannot happen today, because the memory module only advertises DESC order for a non-nullable leading column. If that changes, the streaming code still relies on NULL rows sitting together at one edge, which holds in either direction. The existing comment in `findNonFinitePeerSpan` ("non-finite rows cluster at edges") already says this, so I added no new NOTE.

Validation: `yarn workspace @quereus/quereus test`: 11143 passing, 26 pending, 0 failing. `yarn workspace @quereus/quereus lint`: clean.
