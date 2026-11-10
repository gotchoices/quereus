---
description: A window frame like "all rows within 10 of the current row's value" used to silently drop the "within 10" part when the ordering column held text (or anything non-numeric); it now raises an error instead, as PostgreSQL and SQLite do.
files:
  - packages/quereus/src/planner/building/select-window.ts      # validateRangeOffsetFrame + isOffsetBound, called per window group
  - packages/quereus/src/runtime/emit/window.ts                 # rangeOrdinal now throws for non-null non-numeric values
  - packages/quereus/src/planner/rules/window/rule-monotonic-window.ts  # isRangeSlidingEligible doc comment only (logic unchanged)
  - packages/quereus/test/plan/window-one-sided-frames.spec.ts  # non-numeric case rewritten
  - packages/quereus/test/logic/07.5-window.sqllogic            # new range_types block after the RANGE offset cases
  - docs/window-functions.md                                    # RANGE vs ROWS, Frame Specifications, rule bail list, test coverage list
repro: verified
---

# Reject a numeric RANGE frame offset over a non-numeric ORDER BY key — review handoff

## What changed

**Prepare-time check (`select-window.ts`, `validateRangeOffsetFrame`).** Runs once per window group, right after the ORDER BY expressions are built. It applies only to `range` frames where the start or end bound is `n preceding` / `n following`. It raises:

- `RANGE with offset PRECEDING/FOLLOWING requires exactly one ORDER BY key; got N` (`StatusCode.ERROR`, located at the offset expression) for zero or 2+ ORDER BY keys. This is the "second arm" the ticket put outside the letter of the maintainer decision; it is included. If the reviewer disagrees, drop that `if` block and file to backlog.
- `RANGE with offset PRECEDING/FOLLOWING over a <TYPE> ORDER BY key requires an interval offset, which is not supported yet` (`StatusCode.UNSUPPORTED`, located at the ORDER BY key) for temporal key types (DATE, TIME, DATETIME, TIMESTAMP, TIMESPAN).
- `RANGE with offset PRECEDING/FOLLOWING requires a numeric ORDER BY key; got <TYPE>` (`StatusCode.ERROR`, located at the ORDER BY key) for any other non-numeric type (TEXT, BLOB, BOOLEAN, JSON, …).

It accepts `isNumeric` types, `NULL_TYPE` (`order by null` → every frame is the whole NULL peer group) and `ANY_TYPE` (deferred to runtime), by identity against the singletons as `isNumericOrUnknownType` does.

**Runtime check (`window.ts`, `rangeOrdinal`).** NULL → NaN (peer group, unchanged). number → itself, bigint → `Number`. Anything else (string, including a numeric-looking `'5'`; Uint8Array; boolean; JSON) throws `RANGE with offset PRECEDING/FOLLOWING requires a numeric ORDER BY key; got a <text|blob|boolean|json> value`. Only an ANY key can deliver such a value now. `rangeOffsetStart`/`End` are unchanged apart from comments; a non-finite *number* (NaN/Infinity in a REAL column) still gets peer-group treatment.

**Streaming rule.** `isRangeSlidingEligible` logic unchanged; its doc comment now names the two cases that still reach it and must stay buffered: ANY keys, and offset-zero shapes (`current row and current row`, etc.) over non-numeric or multi-key ORDER BY.

## Verified behaviour (ran against source)

| query (table `t(id, k text, n integer, a any, d date)`) | result |
|---|---|
| `count(*) over (order by k range between 1 preceding and 1 following)` | prepare error, `got TEXT` |
| `… order by d range between 1 preceding and 1 following` | prepare error, interval message, UNSUPPORTED |
| `… order by a range …` with a `'x'` or `'5'` row | runtime error, `got a text value` |
| `… order by a range …` with only numeric values | runs |
| `… order by n, id range …` | prepare error, `got 2` |
| `… over (range between 1 preceding and 1 following)` (no ORDER BY) | prepare error, `got 0` |
| `… order by null range between 1 preceding and 1 following` | runs, whole partition |
| `… order by k range between unbounded preceding and current row` | runs |
| `… order by k, n range between current row and current row` | runs |

## Tests

- `test/plan/window-one-sided-frames.spec.ts` "a non-numeric ORDER BY key rejects RANGE offsets and keeps the peer-group frame buffered": rewritten. The three offset bounds over the TEXT key now assert the prepare error on both the streaming and the rule-disabled database; `between current row and current row` still asserts it stays buffered, and now also pins its rows (peer groups of the TEXT key).
- `test/logic/07.5-window.sqllogic`, new `range_types` block: TEXT key error, DATE key error (interval wording), two-key error, no-ORDER-BY error, ANY key with numeric values works, ANY key with a text value errors at runtime, and the `unbounded preceding and current row` positive case over TEXT.
- `yarn workspace @quereus/quereus test`: 11139 passing, 26 pending, 0 failing. `yarn workspace @quereus/quereus lint`: clean. `test:store` not run; the change is in planner/runtime code with no store-specific path.

## Known gaps / things for the reviewer to weigh

- **ANY key + ranking function.** `row_number() over (order by a range between 1 preceding and 1 following)` with a text value in `a` does *not* raise: ranking functions never compute a frame, so `rangeOrdinal` is never reached. TEXT-typed keys raise regardless of function (prepare time). Documented in `docs/window-functions.md` and the `rangeOrdinal` comment. Closing it would mean a separate per-value check in the ranking path; judged not worth it since the frame has no effect on the result there.
- **Runtime error carries no source location** (line/column undefined), unlike the prepare-time errors.
- **Strict storage-class check for ANY.** A numeric-looking string `'5'` in an ANY column is rejected, per the ticket's recommendation. Previously `Number('5')` would have made it work.
- **Error-message wording** for the runtime case uses `getSqlDataTypeName` (`text`, `blob`, `json`) with booleans special-cased to `boolean`, since that helper maps booleans to `integer`.
- `docs/todo.md:120` still lists "RANGE BETWEEN" as an unchecked to-do item; it predates this ticket and was left alone.
