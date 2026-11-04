description: Filtering a date-and-time column with `date(col) = <text with a time in it>` returns rows that the same comparison, evaluated on its own, says do not match, because the query optimizer drops the time part of the text.
architecture: docs/optimizer.md
files:
  - packages/quereus/src/types/temporal-types.ts   # bucketBounds on DATE_TYPE and DATETIME_TYPE
  - packages/quereus/src/planner/rules/predicate/rule-sargable-range-rewrite.ts   # applies the bounds
repro: verified
severity: wrong-result
likelihood: unusual
tradeoffs: Comparing a date to text that contains a time is probably a query mistake and is rare, so a maintainer could reasonably defer this, although the result is silently wrong when it happens.
----

The optimizer rewrites `date(col) = c` into the range `col >= c's midnight and col < next midnight`. It computes those bounds with `Temporal.PlainDate.from(value)`, which accepts text carrying a time or an offset and keeps only the date. The rewritten filter therefore does not mean the same thing as the original comparison.

Reproduced on the memory module:

```sql
create table b (id integer primary key, t datetime null);
insert into b values (1, '2020-01-01T03:00:00'), (2, '2020-01-02T03:00:00');

select id, date(t) = '2020-01-01T10:00:00' as eq from b;
-- eq is false for both rows: a DATE compares to text byte for byte

select id from b where date(t) = '2020-01-01T10:00:00';
-- returns id 1; should return no rows

select id from b where date(t) = '2020-01-01T22:00:00-05:00';
-- returns id 1; should also return no rows

select id from b where date(t) = '2020-01-01[Asia/Tokyo]';
-- returns id 1; should also return no rows: the bounds drop the zone annotation as well
```

Expected behaviour: the filter and the evaluated comparison agree. The rewrite applies only when the constant is exactly a bare date, and otherwise declines, leaving the comparison as written. `date(t) = '2020-01-01'` still rewrites.

**Note, 2026-11-04:** `date-time-timestamp-comparisons-against-text` (now in `implement/`) resolves this. Text compared against a DATE will convert the way a write does, so the literal becomes a bare date before the rewrite runs, and the filter and the evaluated comparison agree. This was confirmed by patching the hook on at load time. That ticket deletes this one once its test covers the repro. The "should return no rows" expectations above assumed byte comparison and no longer apply.
