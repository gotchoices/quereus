---
description: Text compared against a DATE, TIME or TIMESTAMP column should be converted the way a write to that column would convert it, so the text that created a value can find it again. The maintainer accepted this rule, including the changes it makes to some existing query results.
architecture: docs/types.md
files:
  - packages/quereus/src/types/temporal-types.ts              # DATE_TYPE, TIME_TYPE, TIMESTAMP_TYPE gain normalizeComparand; shared helper
  - packages/quereus/src/types/logical-type.ts                # hook doc comment
  - packages/quereus/src/types/comparison-coercion.ts         # comments only; the hook's presence opts a type in
  - packages/quereus/src/runtime/emit/subquery.ts             # arm 1c comment only
  - packages/quereus/test/logic/98-temporal-edge-cases.sqllogic # d_filter / t_filter section pins the old behaviour
  - packages/quereus/test/logic/15.1.4-datetime-comparison-normalization.sqllogic # model for the new test file
  - docs/types-ordering.md                                    # section "DATETIME against text" generalizes
  - docs/datetime.md                                          # lines 59-73 state the old raw-comparison contract
  - docs/types.md                                             # DATE / TIME / TIMESTAMP entries
  - docs/usage-types.md                                       # one sentence at line 95
  - tickets/backlog/bug-date-bucket-rewrite-accepts-non-date-text.md # this change resolves it; see below
  - .release-notes.pending.md                                 # untracked and gitignored; see docs/releasing.md
repro: verified
---

# Comparing a DATE, TIME or TIMESTAMP against text normalizes the text the way a write does

## Settled decision (maintainer, 2026-11-04): do not reopen

> Comparing a DATE, TIME or TIMESTAMP column against text normalizes the text exactly as a write to that column would. Text that does not parse compares as it does today. A comparison asks whether the column's value equals what this text would have stored.

The change in results is intended and must be called out in the release notes. Two alternatives were rejected: reading a DATE as midnight when the text has a time, and leaving DATE out. Nothing stored changes.

## Cause

`LogicalType.normalizeComparand` already provides everything: defining it opts a type in, and `crossTypeCoercion`, `comparisonGroupCoercions`, `makeComparisonGroup`, `inMembershipKeys` and the change-scope binding all read it. Only `DATETIME_TYPE` defines it, so the other three types compare the query's text unconverted against the stored spelling. For TIMESTAMP the stored value is an integer, so text never equals it.

So the one site to change is the three type definitions in `temporal-types.ts`. No planner or runtime logic should need to change.

## Evidence: the hooks were tried without editing source

The hooks below were patched onto the type objects from a scratch script at load time, then compared with the unpatched v4.25.0 build. Each query ran over an unindexed column, a secondary index (TIMESTAMP only) and a primary key, and all routes agreed unless noted.

| Column holds | Comparison | Today | With hook |
|---|---|---|---|
| DATE `2024-01-16` | `dd = '2024-01-15T23:00:00-05:00'` | no match | match |
| DATE `2024-01-15` | `dd = '2024-01-15T12:00:00'` | no match | match |
| DATE `2024-01-15`, `2024-01-16` | `dd < '2024-01-16T12:00:00'` | both | only `2024-01-15` |
| DATE | `dd = 'junk'` | no match | no match |
| TIME `12:00:00` | `tt = '12:00'`, `'12:00:00.000'`, `'2024-01-15T14:00:00+02:00'` | no match | match |
| TIME `12:00:00` | `tt = '12:00:00-05:00'` (a write rejects this) | no match | no match |
| TIMESTAMP `1577836800000` | `tm = '2020-01-01T00:00:00Z'` | no match | match |
| TIMESTAMP `1000` | `tm = '1000'`, `tm = ' 1000 '` | no match | match |
| TIMESTAMP | `tm = 'junk'`, `tm in ('junk')` | no match | no match |
| TIMESTAMP | `tm <> 'junk'`, `tm < 'junk'` | every row | every row |
| TIMESTAMP | `tm <> ''` | every row | **no rows** (see below) |
| TIMESTAMP `1000` | `tm = ?` bound to `1000`, `'1000'` | match, no match | match, match |
| TIMESTAMP | `tm = ?` bound to `5.5`, `true`, `'junk'` | no match | no match |
| TIMESTAMP `1000` | `tm in (select s from txt)`, `join on m.tm = s` with `s` = `'1000'` | no match | match |
| TIMESTAMP `1000` | `case tm when '1000' …` | no match | match |
| DATE, number bound | `dd = ?` bound to `5` | no match | no match |

Plans: a literal folds to the stored form and still plans as `INDEX SEEK` or `INDEX RANGE` (`LITERAL 1000` for `tm = '1000'`); a parameter keeps `CAST(? AS TIMESTAMP)` in its seek key.

`greatest(tm, 'junk')` still returns `'junk'` and `nullif(tm, 'junk')` still returns `tm`, so arguments that these builtins return are not altered.

**Whole suite with the hooks preloaded:** `packages/quereus` 11,005 passing, 26 pending, 1 failing. The one failure is the `d_filter` query at `98-temporal-edge-cases.sqllogic:496`, which pins the old behaviour. A logic file stops at its first failure, so the `t_filter` queries below it have not been observed and are expected to need the same rewrite. This run was the memory backend only; `yarn test:store` was not run.

`QUEREUS_REPR_STRICT=1` over the probe script gave identical results. That covers only the probe queries, not the full `yarn test:repr-strict`.

## Three things that look wrong and are not

**Unparseable text against an integer column.** `TIMESTAMP_TYPE.compare` uses JS `<` and `>`, which would call `5 vs 'junk'` equal. This does not reach a wrong answer: the probes above return no match for `tm = 'junk'` over a primary key and a secondary index. Unparseable text was already reaching those seeks raw before this change (today's plan also shows `LITERAL 'junk'` in the seek), so the hook adds no new exposure. The store backend has not been probed for this, so the new test file must include these cases and run under `yarn test:store`.

**Blank text against TIMESTAMP.** A write of `''` or whitespace to a TIMESTAMP stores NULL, so under the accepted rule the comparison is against NULL: `tm = ''`, `tm <> ''` and `tm not in ('')` all match no rows. `tm <> ''` currently matches every row, so this is a change. Keep it: it is what the rule says, and INTEGER already behaves this way (`i = ''`, `i <> ''` and `i not in ('')` match no rows, confirmed). The cast already reports itself nullable. Pin it in the test and name it in the release note. DATE and TIME reject blank text on write, so for them it stays text.

**`date(col) = <text>`.** `date()` returns DATE, so this comparison changes too, and it resolves `bug-date-bucket-rewrite-accepts-non-date-text`. Constant folding normalizes the literal before the range rewrite sees it, so the filter and the evaluated comparison now agree:

| Literal, rows `2020-01-01T03:00:00` (id 1) and `2020-01-02T03:00:00` (id 2) | Today: evaluated / filter | With hook: evaluated / filter |
|---|---|---|
| `2020-01-01` | 1 / 1 | 1 / 1 |
| `2020-01-01T10:00:00` | none / 1 | 1 / 1 |
| `2020-01-01T22:00:00-05:00` | none / 1 | 2 / 2 |
| `2020-01-01[Asia/Tokyo]` | none / 1 | none / none |

That backlog ticket's stated expectation ("should return no rows") assumed byte comparison and no longer applies. Its disagreement is the defect, and this removes it. A parameter does not reach the rewrite.

## Design

All four hooks have the same shape, so share one helper, and share the text conversion with `parse` so a write and a comparison cannot drift:

```ts
/** `normalizeComparand` for a type whose text form goes through `parseText`. */
const normalizesTextAs = (parseText: (text: string) => SqlValue) => (v: SqlValue): SqlValue => {
	if (typeof v !== 'string') return v;
	try {
		return parseText(v);
	} catch {
		// Not a failure: text the type rejects is a legal operand, compared as text.
		return v;
	}
};
```

Extract one text-to-stored function per type (DATE: `parseDateTimeStringToUtcPlain(text).toPlainDate().toString()`; TIME: `parseTimeStringToUtcPlain(text).toString()`; DATETIME: `parseDateTimeStringToUtcPlain(text).toString()`; TIMESTAMP: the whole string arm of its `parse`, including trimming, blank to NULL, integer-shaped text and bigint widening). `parse` calls that function and keeps its own error wrapping; the hook calls it directly. Only text converts: a number stays a number, although a write reads it as an epoch.

The per-row `NOTE:` at DATETIME's hook moves to the shared helper. TIME's parser can throw more times than DATETIME's before it succeeds on bare time text, so do not reuse the 23-32 us figure for TIME without measuring it.

## TODO

- Add `normalizesTextAs` and the extracted text conversions in `temporal-types.ts`; give DATE, TIME and TIMESTAMP the hook and move DATETIME onto the helper.
- Update the wording that says only DATETIME has the hook: the `logical-type.ts` hook comment (mention that a type may map text to NULL), arm 2 and the hash-join `NOTE` in `crossTypeCoercion`, the mixed-list `NOTE` in `comparisonGroupCoercions`, arm 1c in `subquery.ts`, and the gate comment `DATETIME takes arm 2`.
- Add `packages/quereus/test/logic/15.1.5-date-time-timestamp-comparison-normalization.sqllogic`, modelled on `15.1.4`: the table above over an unindexed column, a secondary index and a primary key, plus bound parameters, blank TIMESTAMP text and the `date(col) = <text>` table. Confirm it fails before the change.
- Rewrite the `d_filter` / `t_filter` section of `98-temporal-edge-cases.sqllogic` to pin the new rule, including its header comment.
- Delete `tickets/backlog/bug-date-bucket-rewrite-accepts-non-date-text.md` once its repro passes in the new test, and say so in the handoff.
- Docs. Generalize `docs/types-ordering.md` § DATETIME against text (including "only DATETIME defines it") and update the links to it if the heading changes, in `docs/types.md`, `docs/datetime.md` and `docs/usage-types.md`. Replace the raw-comparison paragraph in `docs/datetime.md`, which also names the `d_filter` tests. Change the DATE and TIME `Comparison:` bullets in `docs/types.md` and add the rule to its TIMESTAMP entry. `docs/types.md` is at 11,870 words against a 12,000 cap (`docs/doc-conventions.md`), so keep it to pointers and put the detail in the satellite. State the two consequences readers will trip on: a DATE compared with text carrying a time compares the date part only, and blank text against a TIMESTAMP is NULL.
- Append to `.release-notes.pending.md` (create it if absent; it is gitignored, so the commit will not carry it, and say so in the handoff). The note covers: text compared with DATE, TIME and TIMESTAMP now converts as a write would; the before and after for `dd = '2024-01-15T12:00:00'` (false to true) and `dd < '2024-01-15T12:00:00'` (true to false); `date(col) = <text with a time>` now compares that text's date; `tm <> ''` now matches no rows.
- Validate: `yarn lint`, `yarn docs:check`, `yarn test`, `yarn test:store`, `yarn test:repr-strict`.
