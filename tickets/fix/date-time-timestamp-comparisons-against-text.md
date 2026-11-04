---
description: DATE, TIME and TIMESTAMP columns have the same search problem just fixed for DATETIME, where the text that created a value cannot find it again, but fixing DATE changes what some existing comparisons mean. Needs a decision on whether these columns should follow DATETIME.
prereq: bug-datetime-literal-with-timezone-never-matches
architecture: docs/types.md
files:
  - packages/quereus/src/types/temporal-types.ts       # DATE_TYPE, TIME_TYPE, TIMESTAMP_TYPE would each implement the comparison hook
  - packages/quereus/src/types/comparison-coercion.ts  # no change expected; the hook's presence opts a type in
repro: verified
---

**Blocked: the specification is silent. Unblocks when a maintainer accepts or edits the proposed rule below.**

## What happens today

The 2026-11-03 decision on `bug-datetime-literal-with-timezone-never-matches` covers DATETIME only. The other temporal types that rewrite text on the way in have the same gap. Results from the v4.25.0 build:

| Column holds | Comparison | Result |
|---|---|---|
| DATE `2024-01-16` | `dd = '2024-01-15T23:00:00-05:00'` | no match, although inserting that text stores `2024-01-16` |
| TIME `12:00:00` | `tt = '12:00:00.000'` | no match |
| TIME `12:00:00` | `tt = '12:00'` | no match |
| TIME `12:00:00` | `tt = '2024-01-15T14:00:00+02:00'` | no match, although inserting that text stores `12:00:00` |
| TIMESTAMP inserted as `'2020-01-01T00:00:00Z'` (stored `1577836800000`) | `tm = '2020-01-01T00:00:00Z'` | no match |

`docs/types.md` promises "equal instants compare equal regardless of input shape" only for DATETIME. For DATE and TIME it says only "Comparison: Lexicographic", which is why this is a decision and not a bug against the docs.

## Why it is not simply the same fix

Converting DATETIME text loses nothing. Converting text for a DATE column can: a write keeps only the date part. Normalizing the way a write does would change these, shown for a DATE column holding `2024-01-15`:

| Comparison | Today | If normalized |
|---|---|---|
| `dd = '2024-01-15T12:00:00'` | false | true |
| `dd < '2024-01-15T12:00:00'` | true | false |

The same applies to TIME against text carrying a date.

TIMESTAMP has a different wrinkle: its stored value is an integer, so a normalized comparison compares numbers, and an integer-shaped string already means "this integer" on write.

## Proposed rule (recommended default)

> Comparing a DATE, TIME or TIMESTAMP column against text normalizes the text exactly as a write to that column would. Text that does not parse compares as it does today. A comparison asks whether the column's value equals what this text would have stored.

Once `bug-datetime-literal-with-timezone-never-matches` lands, this should be small: each type implements the same comparison hook DATETIME got. Nothing stored changes.

## Alternatives rejected

- **Precision-preserving comparison**, reading a DATE as midnight when the text has a time, so `dd = '2024-01-15T12:00:00'` stays false. It is arguably more exact, but it needs a separate comparison rule per type pair and disagrees with what a write of the same text produces, which is the disagreement this work is removing.
- **Normalize TIME and TIMESTAMP only, leave DATE.** It avoids the change above, but it leaves the most common column type with the round-trip failure, and the rule becomes harder to state.

## If we do nothing

Lookups on these columns with a spelling other than the stored one keep returning no rows, with no error. Applications can work around it by writing `dd = date('…')` explicitly.

## Reversibility

Easy to reverse. Only query results change; no stored value or index is rewritten.

## Decided by the maintainer 2026-11-04

The proposed rule above is accepted as written, for DATE, TIME and TIMESTAMP. The change in results shown above is intended, so call it out in the release notes.
