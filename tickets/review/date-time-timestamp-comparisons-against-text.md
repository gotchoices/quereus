---
description: Text compared against a DATE, TIME or TIMESTAMP column now converts the way a write to that column would, so the text that created a value can find it again. This intentionally changes some existing query results, and those changes need a review pass.
architecture: docs/types.md
files:
  - packages/quereus/src/types/temporal-types.ts              # normalizesTextAs helper, one text conversion per type, the three new hooks
  - packages/quereus/src/types/logical-type.ts                # hook comment; a hook may return NULL
  - packages/quereus/src/types/comparison-coercion.ts         # comments only
  - packages/quereus/src/runtime/emit/subquery.ts             # arm 1c comment only
  - packages/quereus/src/runtime/emit/temporal-arithmetic.ts  # comment only
  - packages/quereus/test/logic/15.1.5-date-time-timestamp-comparison-normalization.sqllogic # new
  - packages/quereus/test/logic/98-temporal-edge-cases.sqllogic # d_filter / t_filter now pin the new rule
  - packages/quereus/test/logic/15.1.4-datetime-comparison-normalization.sqllogic # header reference to the renamed doc section
  - docs/types-ordering.md                                    # section renamed and generalized
  - docs/datetime.md
  - docs/types.md
  - docs/usage-types.md
---

# Comparing a DATE, TIME or TIMESTAMP against text normalizes the text the way a write does

## Settled decision (maintainer, 2026-11-04): do not reopen

> Comparing a DATE, TIME or TIMESTAMP column against text normalizes the text exactly as a write to that column would. Text that does not parse compares as it does today. A comparison asks whether the column's value equals what this text would have stored.

The changes in results are intended. Reading a DATE as midnight when the text has a time, and leaving DATE out, were both rejected. Nothing stored changes.

## What changed

The only behaviour change is in `temporal-types.ts`. DATE, TIME and TIMESTAMP now define `normalizeComparand`, the hook DATETIME already had. Defining it opts a type in to the existing coercion in `crossTypeCoercion`, `comparisonGroupCoercions`, `makeComparisonGroup`, `inMembershipKeys` and the change-scope binding. No planner or runtime logic changed.

All four hooks come from one helper, `normalizesTextAs`. It calls the same text conversion the type's `parse` calls (`dateFromText`, `timeFromText`, `dateTimeFromText`, `timestampFromText`), so a write and a comparison cannot drift. The per-row cost `NOTE:` moved from DATETIME to the helper. `parse` keeps its own error wrapping.

## Use cases to check

| Column holds | Comparison | Before | After |
|---|---|---|---|
| DATE `2024-01-15` | `d = '2024-01-15T12:00:00'` | false | true |
| DATE `2024-01-15` | `d < '2024-01-15T12:00:00'` | true | false |
| DATE `2024-01-16` | `d = '2024-01-15T23:00:00-05:00'` | false | true |
| TIME `12:00:00` | `t = '12:00'`, `'12:00:00.000'`, `'2024-01-15T14:00:00+02:00'` | false | true |
| TIME `12:00:00` | `t = '12:00:00-05:00'` (a write rejects this) | false | false |
| TIMESTAMP `1577836800000` | `ts = '2020-01-01T00:00:00Z'` | false | true |
| TIMESTAMP `1000` | `ts = '1000'`, `ts = ' 1000 '`, `ts = ?` bound to `'1000'` | false | true |
| TIMESTAMP | `ts <> ''`, measured on `ts <> ?` too | every row | no rows |
| TIMESTAMP | `ts = 'junk'`, `ts > 'junk'` | no rows | no rows |
| TIMESTAMP | `ts <> 'junk'`, `ts < 'junk'` | every row | every row |
| DATE, TIMESTAMP | number bound: `d = ?` with `5`, `ts = ?` with `5.5` or `true` | no match | no match |

`date(col) = <text>` now agrees between the filter and the evaluated comparison. `date(t) = '2020-01-01T22:00:00-05:00'` names 2020-01-02 in UTC and finds that row, and `date(t) = '2020-01-01[Asia/Tokyo]'` names 2019-12-31.

Why unparseable text against TIMESTAMP stays correct: `TIMESTAMP_TYPE.compare` alone would call `5` and `'junk'` equal, but `createTypedComparator` orders a storage-class mismatch before it calls the type's `compare`. The new test pins this over a scan, a secondary index and a primary key on both backends.

## Plans

Measured with `query_plan()` on the memory module:

- `ts = '1000'`, `ts < '…Z'`, `ts in ('1000', '2000')`, `d = '…T12:00:00'` and `t = '12:00'` fold to the stored form and plan as `INDEX SEEK` or `INDEX RANGE`.
- `ts = ?` plans as `INDEX SEEK` with `CAST(? AS TIMESTAMP)` in the key.
- `ts = ''` plans as `EMPTY RESULT`.
- `ts = 'junk'` plans as `INDEX SEEK` with `LITERAL 'junk'`.
- `ts_col = text_col`, `date_col = text_col` and `time_col = text_col` plan as `INNER JOIN ON condition`, not a hash join. The `NOTE:` in `crossTypeCoercion` covers this.

## Tests

- **Added `15.1.5-date-time-timestamp-comparison-normalization.sqllogic`**: pins the rule above. It covers each seekable predicate over an unindexed column, a secondary index and a primary key, plus bound parameters, blank TIMESTAMP text, kept unparseable text, the other comparison sites (`IN` subquery, join, simple `case`, `greatest`, `nullif`) and the `date(col) = <text>` table. With the three hooks removed it fails at line 41, `d = '2024-01-15T12:00:00'`.
- **Changed `98-temporal-edge-cases.sqllogic`**: the `d_filter` and `t_filter` queries that pinned the old raw comparison now expect a match.

## Validation

All run on the final code.

- `yarn lint`: clean.
- `yarn docs:check`: OK.
- `yarn test`: exit 0, `packages/quereus` 11,007 passing, 26 pending. Its run took 10m 34s and outlasted the tool's foreground timeout, then completed in the background.
- `yarn test:store`: 11,000 passing, 33 pending.
- `yarn test:repr-strict`: 11,017 passing, 16 pending.

## Other things done

- Deleted `tickets/backlog/bug-date-bucket-rewrite-accepts-non-date-text.md`. Its repro now passes in section 5 of the new test.
- `.release-notes.pending.md` was created. It is gitignored, so **the commit does not carry it** and it stays only in this working copy.

## Known gaps and judgement calls

- **TIME's per-row parse cost is not measured.** A text column compared against TIME parses per row, and TIME's parser can throw more times than DATETIME's before it succeeds on bare time text. The `NOTE:` on `normalizesTextAs` says so. The memo in `comparandConverter` covers literals and parameters but not this shape.
- **`docs/types.md` is at 11,946 words, 54 under the 12,000 cap** (it was 11,870). The next addition of any size needs a split.
- **`docs/types.md` had no TIMESTAMP entry**, although the ticket asked to add the rule to one. I added a short `**TIMESTAMP**` entry to the Temporal Types list instead. Its other properties remain documented elsewhere in that file.
- **The `docs/types.md` link text is shortened** to "Comparison against text" to save words. The other docs use the full section title.
- **The new test is long**, about 500 lines, because it repeats each seekable predicate over three table shapes as the ticket specified. Trim it if some shapes prove redundant, keeping the unparseable-text and blank-text cases on all three.
- **Change scopes were not exercised by a new test.** `bindParameters` runs the same converter, so `ts = ?` bound to `''` watches a NULL key. Nothing can match that key, so the worst case is an unnecessary notification when a NULL-keyed row changes. This is from reading the code, not from running it.
- **The non-materialized `IN` paths with a blank member were read, not run.** Every path in `emitIn` converts the member and then checks for NULL (`runtime/emit/subquery.ts`), but the test only exercises `not in (select s from blanks)`. The comment at line 281 still names only the object-arm reason for a NULL key.
