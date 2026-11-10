description: A window frame like "rows within 1 of the current row's value" gives the wrong rows when the window is sorted in descending order — it ignores the sort direction and treats "preceding" as "smaller values", so frames come out too wide or wrong.
files:
  - packages/quereus/src/runtime/emit/window.ts   # rangeOffsetStart / rangeOffsetEnd (buffered walk); streaming range scan near orderByVal0Num
  - packages/quereus/test/logic/07.5-window.sqllogic
repro: verified
severity: wrong-result
likelihood: normal-use
tradeoffs: DESC RANGE offset frames are less common than ASC ones, and the fix touches the frame arithmetic that both the buffered and the streaming paths must agree on.
----
# RANGE `n PRECEDING` / `n FOLLOWING` ignores a DESC ORDER BY

## Observed

```sql
create table t (id integer primary key, n integer);
insert into t values (1,1),(2,2),(3,3);
select id, count(*) over (order by n desc range between 1 preceding and 1 following) c from t;
```

Returns `c = 3` for every row. Expected (PostgreSQL, SQLite): under `desc`, "preceding" means earlier in the sort, i.e. *larger* values, so the frame for value `v` is `[v + 1 .. v - 1]` in sort order: n=3 → {3,2} = 2, n=2 → {3,2,1} = 3, n=1 → {2,1} = 2.

## Cause (read from code)

`rangeOffsetStart` / `rangeOffsetEnd` in `runtime/emit/window.ts` compute `target = currentVal + offset` (offset negative for PRECEDING) and scan for the first row `>= target` / last row `<= target`. Both assume an ascending key: for a DESC key the offset sign must flip and the comparisons must reverse. The ORDER BY direction is available on the window spec (`orderClause.direction`).

Not yet checked: whether the streaming range scan (`rule-monotonic-window.ts` allows a DESC leading key when the source is monotonic DESC; the scan lives near `orderByVal0Num` in the same emitter) has the same assumption. The fix must keep the two paths agreeing — `test/plan/window-one-sided-frames.spec.ts` has a `bothShapes` helper that runs a query on the streaming and the rule-disabled database for exactly this.

## Expected behaviour

A DESC ORDER BY key gives RANGE offset frames mirrored from the ASC case, on both the buffered and the streaming path, with NULL-keyed rows still forming their own peer group.
