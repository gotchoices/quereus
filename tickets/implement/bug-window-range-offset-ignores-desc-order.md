description: A window frame like "rows within 1 of the current row's value" gives the wrong rows when the window is sorted in descending order. It ignores the sort direction and treats "preceding" as "smaller values", so frames come out too wide, too narrow, or empty.
architecture: docs/window-functions.md
files:
  - packages/quereus/src/runtime/emit/window.ts   # buffered: getFrameBounds / rangeOffsetStart / rangeOffsetEnd / rangeOrdinal (~L582-800); streaming: orderByVal0Num (~L1150) feeding handleSlidingRangeArrival / findRangeWindow / trimSlidingRangeBuffer (~L1535-1680)
  - packages/quereus/test/logic/07.5-window.sqllogic   # RANGE offset section ~L657-747
  - packages/quereus/test/plan/window-one-sided-frames.spec.ts   # bothShapes / expectStreamingModes helpers
  - docs/window-functions.md   # RANGE offset paragraph ~L212 ("[v - n, v + m]")
repro: verified
----
# RANGE `n PRECEDING` / `n FOLLOWING` ignores a DESC ORDER BY

## What the SQL standard (and PostgreSQL, SQLite) require

Under `order by k desc`, "preceding" means earlier in the sort, which is *larger* values. So `range between n preceding and m following` over a DESC key covers the values `[v - m, v + n]`, the mirror of the ASC interval `[v - n, v + m]`. A NULL-keyed row still forms its own peer group as its frame.

## Reproduced

Both physical paths are wrong. Each was run on a normal database and on one with the `monotonic-window` rule disabled.

**Buffered path** (any DESC ORDER BY; this is the common case):

```sql
create table t (id integer primary key, n integer);
insert into t values (1,1),(2,2),(3,3);
select id, count(*) over (order by n desc range between 1 preceding and 1 following) c from t;
-- got c = 3 for every row; expected id3 → 2, id2 → 3, id1 → 2
```

**Streaming path.** It is reachable when the source advertises a descending monotonic order, for example a primary key declared `desc`. The memory module only advertises DESC for a non-nullable leading column (`buildMonotonicAdvertisement`, vtab/memory/module.ts), so NULLs never reach the streaming DESC case. Here the streaming answer is NULL frames, so the two paths also disagree with each other:

```sql
create table d (id integer, v integer, primary key (id desc));
insert into d values (1,1),(2,2),(3,4),(5,8),(8,16);
select id, sum(v) over (order by id desc range between 2 preceding and 1 following) s from d;
-- streaming: 8→16, 5→null, 3→null, 2→null, 1→null
-- buffered:  31 for every row
-- expected:  8→16, 5→8, 3→14, 2→7, 1→7
select id, sum(v) over (order by id desc range between 2 preceding and current row) s from d;
-- streaming: 8→16, then null; buffered: 16,24,28,30,31
-- expected:  8→16, 5→8, 3→12, 2→6, 1→7
```

(`query_plan` shows `streaming.modes = ["slidingAgg"]` for these on the default database. `order by id desc` over an ASC integer primary key did *not* stream in the same experiment, so use a `primary key (id desc)` fixture to reach the streaming path.)

ROWS frames over DESC are correct on both paths. Only RANGE offset arithmetic is affected.

## Cause

Both paths do the offset arithmetic on the raw key value and assume the sort ascends:

- Buffered: `rangeOffsetStart` / `rangeOffsetEnd` compute `target = currentVal ± offset` and scan for the first row `>= target` / last row `<= target`.
- Streaming: `handleSlidingRangeArrival` closes an entry when an arrival `> v_j + following`. `findRangeWindow` takes `[v_j - preceding, v_j + following]` and `break`s on `v > right`. `trimSlidingRangeBuffer` drops rows `< v_p - preceding`. All of these assume the buffer's finite values increase.

## Fix

Normalize the key by the sort direction once, at the single place each path turns an ORDER BY value into a number. Let `sign = orderBy[0].direction === 'desc' ? -1 : 1`. Then `sign * value` increases along the sort order in both directions, and all the existing ascending arithmetic is correct unchanged. NaN stays NaN, so the NULL / non-finite peer-span handling is unaffected.

- Buffered: thread the sign into `rangeOffsetStart` / `rangeOffsetEnd`, via `getFrameBounds`, from `plan.windowSpec.orderBy[0]?.direction`, which the emitter already reads at L68. Multiply each `rangeOrdinal(...)` result by it. A small helper is the obvious home, for example a `rangeOrdinal(value, sign)` overload or a wrapper.
- Streaming: compute `orderByVal0Num` as `sign * Number(orderByLead)`, with the sign taken from `plan.windowSpec` once per emit, not per row. Nothing downstream (`slidingBuffer[].orderByVal0`, `v_j`) is read for its real value, only for range arithmetic. Confirm that while editing: grep `orderByVal0` / `v_j` for any use that leaves the number in a result.
- Keep the two paths agreeing. Update the `rangeOrdinal` doc comment, which says it "mirrors the streaming emitter's `orderByVal0Num`", so it also names the direction sign.

Alternative considered: flip the offset sign and reverse the comparisons in every scan. Rejected because it touches about six comparison sites across two paths, each a chance to diverge. The normalization touches one site per path.

## TODO

- Apply the sign normalization in the buffered path (`getFrameBounds` → `rangeOffsetStart` / `rangeOffsetEnd`).
- Apply it in the streaming path (`orderByVal0Num`).
- Add sqllogic cases in `07.5-window.sqllogic`'s RANGE offset section (buffered path): the `t` repro above, plus a nullable DESC case. For example, over `range_null` (NULL, NULL, 10, 20, 30), `count(*) over (order by val desc range between 10 preceding and current row)` → 30:1, 20:2, 10:2, each NULL row:2 (its peer group). Check where NULLs sort under DESC in Quereus before writing the expected row order.
- Add one `bothShapes` + `expectStreamingModes` case to `window-one-sided-frames.spec.ts` (or a sibling describe) with a `primary key (id desc)` fixture, using the two `d` queries above. This pins streaming == buffered == expected for DESC RANGE.
- Update `docs/window-functions.md` near L212: the interval is `[v - n, v + m]` for ASC and mirrored, `[v - m, v + n]`, for DESC.
- Run `yarn workspace @quereus/quereus test` and `yarn workspace @quereus/quereus lint`.
