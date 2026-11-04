---
description: Text compared against a DATE, TIME or TIMESTAMP column now converts the way a write to that column would, so the text that created a value can find it again. This intentionally changes some existing query results.
architecture: docs/types.md
files:
  - packages/quereus/src/types/temporal-types.ts              # normalizesTextAs, one text conversion per type, the three new hooks, bareDateBucket
  - packages/quereus/src/types/logical-type.ts                # hook comment; a hook may return NULL
  - packages/quereus/src/types/comparison-coercion.ts         # comments only
  - packages/quereus/src/runtime/emit/subquery.ts             # comments only
  - packages/quereus/src/runtime/emit/temporal-arithmetic.ts  # comment only
  - packages/quereus/test/logic/15.1.5-date-time-timestamp-comparison-normalization.sqllogic # new
  - packages/quereus/test/logic/98-temporal-edge-cases.sqllogic # d_filter / t_filter now pin the new rule
  - packages/quereus/test/logic/15.1.4-datetime-comparison-normalization.sqllogic # header reference to the renamed doc section
  - docs/types-ordering.md                                    # section renamed and generalized
  - docs/optimizer-rule-families.md                           # the date rewrite takes only a bare date
  - docs/datetime.md
  - docs/types.md
  - docs/usage-types.md
---

# Comparing a DATE, TIME or TIMESTAMP against text normalizes the text the way a write does

## Settled decision (maintainer, 2026-11-04)

> Comparing a DATE, TIME or TIMESTAMP column against text normalizes the text exactly as a write to that column would. Text that does not parse compares as it does today. A comparison asks whether the column's value equals what this text would have stored.

Reading a DATE as midnight when the text has a time, and leaving DATE out, were both rejected. Nothing stored changes.

## What was built

DATE, TIME and TIMESTAMP now define `normalizeComparand`, the hook DATETIME already had. Defining it opts a type in to the existing coercion in `crossTypeCoercion`, `comparisonGroupCoercions`, `makeComparisonGroup`, `inMembershipKeys` and the change-scope binding.

All four hooks come from one helper, `normalizesTextAs`, which calls the same text conversion the type's `parse` calls (`dateFromText`, `timeFromText`, `dateTimeFromText`, `timestampFromText`), so a write and a comparison cannot drift.

The review added one behaviour change: the `date(col) = c` range rewrite now takes only a constant that is already a bare date (`bareDateBucket`).

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

## Review findings

Read the diff of `ticket(implement): date-time-timestamp-comparisons-against-text` first, then ran about 500 edge-case queries on the memory module with a throwaway script.

### Fixed in this pass

- **`date(col) = <text>` still disagreed for text a write rejects.** `date(t) = '2020-01-01[Mars/Base]'` returned row 1 as a filter while the same comparison evaluated to false for every row (`verified`, on DATE and DATETIME columns, scan and index). The zone cannot be resolved, so the text stays text, and `Temporal.PlainDate.from` still read a date out of it. This is the bug the implement stage deleted from the backlog as resolved; only its listed repro cases were. `bucketBounds` on both types now goes through `bareDateBucket`, which declines anything that is not already a bare date. That is the expected behaviour the deleted ticket stated. Pinned in section 5 of the new test; the probe returned row 1 before the fix and no rows after.
- **Range seeks with a bound that converts at run time had no test.** Added `m < ?` and `m > ?` bound to `'junk'`, and `m >= ?` bound to `''`, over the secondary index and primary key. They passed on both backends, so this closes a coverage gap rather than a defect. The store encodes these keys differently, which is why the cases earn their place.
- **TIME's per-row parse cost, listed as unmeasured, is now measured.** A text column compared against a typed column, 5,000 rows, median of 5 runs: TIME 72-75 us, DATETIME 70 us, DATE 67 us, against 2-3 us with no parse. TIME is not materially worse. The `NOTE:` on `normalizesTextAs` now says so.
- **Stale comments.** The NULL-key comment in `emitIn` named only the object arm and now also names blank text against TIMESTAMP. `textCoercionTarget` cited "rule 2", which is arm 3.
- **Docs.** `docs/types-ordering.md` and `docs/optimizer-rule-families.md` now state the bare-date gate.

### Filed

- `bug-in-over-dml-subquery-reuses-first-rows-answer` (backlog, `verified`): `x in (insert ... returning ...)` reuses the first outer row's answer for every row. It reproduces on plain INTEGER and TEXT columns, so this ticket did not cause it. Nothing open claimed the site.

### Checked, no defect

Each was run on the memory module unless marked as read.

- **The NULL key from blank text.** `<`, `<=`, `>`, `>=`, `between`, `not between`, `in`, `not in`, `not (…)` and `or`, with literals and parameters, over scan, secondary index and primary key. `greatest`, `least` and `nullif` treat it as they treat a NULL argument. This closes the handoff's gap about `IN` paths with a blank member: the set-probe, streaming and DML-subquery paths were all run, plus a blank probe.
- **Kept text as a seek key.** Combined bounds (`m > '500' and m < 'junk'`, `m > 'junk' and m > '500'`), contradictions (`m = 'junk' and m = '1000'`) and mixed `IN` lists. `TIMESTAMP_TYPE.compare` is never reached with a mismatched storage class on these paths.
- **Other comparison routes.** `exists`, `not exists`, inner and left joins to TEXT and ANY columns, `in` subqueries over ANY in both directions, `between` with a text probe, `having`, views, a `union all` subquery, CTEs, `collate nocase` on the literal, CHECK constraints, partial index predicates, `update ... where` and `delete ... where`.
- **DATE, TIME, DATETIME and TIMESTAMP against each other.** Unchanged, because these types are not `isTextual`, so none is a comparand source for another.
- **Change scopes (read, not run).** `bindParameters` runs the same converter. A blank parameter on a TIMESTAMP watches a NULL key, which nothing can match, so the worst case is an unnecessary notification. A kept `'junk'` key is the same. This agrees with the handoff.
- **Syntax that cannot reach this.** `is <value>` and row-value comparisons do not parse in this engine.

### Tripwires

- The `NOTE:` on `normalizesTextAs` covers per-row parsing, and the one in `crossTypeCoercion` covers these pairs leaving hash joins. Both were kept. No new tripwires.
- `docs/types.md` is 54 words under its 12,000-word cap and `docs/sync.md` 5 words under. `yarn docs:check` flags both, so they were not parked anywhere else.

### Considered and declined

- **Trimming the new test.** The handoff invited this, since literals fold before access-path selection and so the shapes partly overlap. Kept: the file runs in about a second, a regression in folding would show only on the seek shapes, and cutting the redundant parseable-literal cases would remove only a small share of the file.
- **Unit tests for `bareDateBucket`.** The logic test pins the behaviour at the level a user meets it.

### Empty categories

- **Resource cleanup:** nothing in the diff acquires a resource.
- **Type safety:** no `any` or casts were added beyond the existing `compare` signatures, and `yarn lint` type-checks the tests.
- **Implementer's tests cut:** none. They pin the settled rule, and none restates the implementation or verifies a mock.

## Validation

Run on the final code unless noted.

- `yarn lint`: clean.
- `yarn docs:check`: OK.
- `yarn workspace @quereus/quereus test`: 11,007 passing, 26 pending.
- `yarn test:store`: 11,000 passing, 33 pending.
- **Not re-run after the review's edits:** the other workspaces' tests and `yarn test:repr-strict`. Both passed on the implement-stage code (repr-strict 11,017 passing, 16 pending), and the review's only behaviour change is inside `bucketBounds`.

## Notes

- `tickets/backlog/bug-date-bucket-rewrite-accepts-non-date-text.md` was deleted at the implement stage. Its expected behaviour now holds in full.
- `.release-notes.pending.md` is gitignored, so **the commit does not carry it** and it stays only in this working copy. Its text was still accurate after the review.
- `docs/types.md` has only a short TIMESTAMP entry, covering physical type and comparison. Its other properties remain documented elsewhere in that file.
