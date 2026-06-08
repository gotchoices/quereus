---
description: Streaming sliding-frame window emitter for SUM/COUNT/AVG/MIN/MAX/FIRST_VALUE/LAST_VALUE under `ROWS BETWEEN n PRECEDING AND m FOLLOWING` and `RANGE BETWEEN <num> PRECEDING AND <num> FOLLOWING`. Extends `rule-monotonic-window` recognition and adds a `slidingAgg` mode to `runStreaming`.
files: packages/quereus/src/planner/rules/window/rule-monotonic-window.ts, packages/quereus/src/planner/nodes/window-node.ts, packages/quereus/src/runtime/emit/window.ts, packages/quereus/test/logic/07.5-window.sqllogic, packages/quereus/test/optimizer/monotonic-window.spec.ts, docs/window-functions.md
---

## What was built

A new `slidingAgg` `StreamingWindowFunctionMode` joins the streaming family,
unlocking the one-pass emitter for two sliding shapes:

| Shape | Recognized for |
| --- | --- |
| `ROWS BETWEEN n PRECEDING AND m FOLLOWING` (literal `n,m ≥ 0` integer) | SUM, COUNT, AVG, MIN, MAX, FIRST_VALUE, LAST_VALUE |
| `RANGE BETWEEN <num> PRECEDING AND <num> FOLLOWING` (literal non-negative numeric, single ORDER BY key) | same set |

Default-frame paths (`UNBOUNDED PRECEDING TO CURRENT ROW`) keep their existing
`runningAgg` / `firstValue` / `lastValue` branches. DISTINCT aggregates,
asymmetric sliding shapes (one side UNBOUNDED), and frame exclusion remain
out of scope and fall through to the buffered path.

### Recognition (`rule-monotonic-window`)

- New `recognizeSlidingFrame(frame)` helper returns `{mode, preceding, following}`
  or null. ROWS requires non-negative integer offsets; RANGE requires
  non-negative finite numeric offsets.
- `recognizeFunctionMode` now accepts `orderByLength` and dispatches to
  `slidingAgg` when the frame matches a sliding shape and the function is in
  the recognized set. RANGE additionally requires `orderByLength === 1`.
- `FIRST_VALUE` / `LAST_VALUE` accept either the default-equivalent frame
  (cache first row's value / current-row pass-through) or a sliding frame
  (returns frame head / tail).
- LAG/LEAD/RANK/DENSE_RANK/ROW_NUMBER continue to reject any explicit frame.

### Runtime (`runtime/emit/window.ts`)

`StreamingFuncState` gained a sliding sub-state with per-function ring buffer
of `{argVal, orderByVal0}`, ROWS bookkeeping (`slidingHead`,
`slidingNextFinalizeIdx`, `{ sum, count }` step+unstep accumulator, pending
list), and RANGE pending list with `{v_j, isFinite, rightClosed}` per entry.

ROWS strategy: each new row pushes its argVal and steps the accumulator
(SUM/COUNT/AVG); pending entries finalize when `pending.length > following`,
left-trimming the buffer so the slice exactly matches the frame; SUM/COUNT/AVG
read the accumulator, MIN/MAX/FIRST/LAST scan the slice. Memory is
`O(preceding + following + 1)` per function per partition.

RANGE strategy: pending entries track `v_j = Number(orderByValues[0])` and an
`isFinite` flag (NULL ordering values coerce to NaN — see review fixes). On
each arrival, pending entries whose right edge has been crossed (or whose
non-finite peer span has ended) are marked closed and front-of-queue closed
entries finalize. Finalization scans the buffer for rows in `[v_j -
preceding, v_j + following]` (finite v_j) or the contiguous non-finite peer
span (non-finite v_j). After each finalize, the buffer is front-trimmed.

`finalizePartition` flushes any remaining pending entries with right edges
clamped to the last partition row.

## Use cases / SQL examples

```sql
-- Centered moving average / sum (3-row window).
SELECT id, SUM(val) OVER (ORDER BY id ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING) AS s,
       AVG(val) OVER (ORDER BY id ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING) AS a
FROM stream_s;

-- Asymmetric (lookback only).
SELECT id, MAX(val) OVER (ORDER BY id ROWS BETWEEN 4 PRECEDING AND 0 FOLLOWING) AS roll_max FROM t;

-- Look-ahead window.
SELECT id, SUM(val) OVER (ORDER BY id ROWS BETWEEN 0 PRECEDING AND 2 FOLLOWING) AS upcoming FROM t;

-- Numeric RANGE (band around current value).
SELECT val, COUNT(*) OVER (ORDER BY val RANGE BETWEEN 10 PRECEDING AND 10 FOLLOWING) AS neighbours FROM r;

-- FIRST_VALUE / LAST_VALUE over a sliding frame.
SELECT id, FIRST_VALUE(val) OVER (ORDER BY id ROWS BETWEEN 2 PRECEDING AND 2 FOLLOWING) AS leader FROM t;
```

## Testing

- `packages/quereus/test/logic/07.5-window.sqllogic` — "Streaming sliding-frame
  tests" section covers ROWS BETWEEN 1/1 for SUM/COUNT/AVG/MIN/MAX,
  asymmetric (2/0), one-sided right (0/2), edge clamping (5/5 over a 6-row
  partition), FIRST/LAST under sliding ROWS, single-row partition, sliding
  SUM with NULL argVals, RANGE BETWEEN 10/10 with peer ties, and NULL
  ordering values under RANGE.
- `packages/quereus/test/optimizer/monotonic-window.spec.ts` — 17 cases,
  including streaming-vs-buffered correctness checks for sliding ROWS
  BETWEEN 1/1, asymmetric 2/0, FIRST/LAST, and (added in review) sliding
  RANGE BETWEEN 10/10 over `(val INTEGER PRIMARY KEY)` so the streaming
  RANGE path is exercised directly (the SQL-logic RANGE tests use a PK on
  `id` ordered by `val`, where the rule cannot fire).
- `yarn lint` (no errors) and `yarn test` (2694 passing in main package, 17
  in the monotonic-window spec) both green.

## Review fixes

1. **`Number(null) === 0` defensive fix** — `runtime/emit/window.ts`'s
   `orderByVal0Num` previously did `Number(orderByValues[0])`, which coerces
   SQL NULL to a finite zero. That would put NULL ordering values into the
   numeric `[v_j - preceding, v_j + following]` window instead of the
   non-finite peer span. Now coerces NULL → NaN explicitly so the
   non-finite branch handles it. Pre-existing buffered-path helpers
   (`findRangeOffsetStart` / `findRangeOffsetEnd`) have the same coercion
   pattern but are out of scope for this ticket.
2. **Streaming RANGE coverage** — added a streaming-vs-buffered correctness
   case in `monotonic-window.spec.ts` using `(val INTEGER PRIMARY KEY)` so
   the rule actually fires for `ORDER BY val RANGE BETWEEN ...`.

## Out of scope (deferred)

- Asymmetric sliding shapes (`UNBOUNDED PRECEDING AND m FOLLOWING`,
  `n PRECEDING AND UNBOUNDED FOLLOWING`, `CURRENT ROW AND m FOLLOWING`).
- Monotonic-deque optimization for MIN/MAX in sliding mode.
- DISTINCT aggregates inside sliding frames.
- GROUPS frame mode and frame exclusion clauses.
- Incremental acc maintenance for RANGE.
