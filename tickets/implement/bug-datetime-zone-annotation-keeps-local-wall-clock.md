description: A date-and-time written with a named time zone is stored as that zone's local clock reading instead of being converted to UTC, so it silently names the wrong instant. This fixes the conversion for all four date and time column types and rejects zones that cannot be resolved.
architecture: docs/types.md#temporal-types
files:
  - packages/quereus/src/types/temporal-types.ts   # parseDateTimeStringToUtcPlain plus the DATE and TIME fallbacks
  - packages/quereus/test/logic/98-temporal-edge-cases.sqllogic   # canonicalization sections cover only [UTC]
  - docs/types.md   # DATE, TIME and DATETIME validation and canonicalization bullets
  - docs/datetime.md   # "Canonicalization for stored column values" section
repro: verified
----

## Cause

`parseDateTimeStringToUtcPlain` (`packages/quereus/src/types/temporal-types.ts:12`) is the one parser behind DATE, TIME, DATETIME and TIMESTAMP string input. Its first branch is `Temporal.ZonedDateTime.from(v).toPlainDateTime()`, which returns the clock reading in the input's own zone. The offset branch below it does convert to UTC.

No other code site is at fault. A search for `ZonedDateTime.from` and `toPlainDateTime` found only this helper and `parseISOString` in `func/builtins/datetime.ts`. `strftime` already reaches UTC through `convertTimezone`. The one-argument `date()`, `time()` and `datetime()` functions call the type `parse`, so this fix covers them too. `epoch_*` functions reject bracketed input with a strict pattern, so they are unaffected.

## Reproduced on the memory module

Run against the built `dist` at HEAD. Each "after" value was produced by calling `Temporal` directly with the proposed conversion, not by running the patched engine. The DATE and TIME values are the date and time parts of the DATETIME value.

| Input | DATETIME now | DATETIME after | DATE after | TIME after |
|---|---|---|---|---|
| `2020-01-01T00:00:00-05:00[America/New_York]` | `2020-01-01T00:00:00` | `2020-01-01T05:00:00` | `2020-01-01` | `05:00:00` |
| `2020-01-01T00:00:00[America/New_York]` (no offset) | `2020-01-01T00:00:00` | `2020-01-01T05:00:00` | `2020-01-01` | `05:00:00` |
| `2020-01-01T22:00:00-05:00[America/New_York]` | `2020-01-01T22:00:00` | `2020-01-02T03:00:00` | `2020-01-02` | `03:00:00` |
| `2020-01-01T05:00:00+09:00[Asia/Tokyo]` | `2020-01-01T05:00:00` | `2019-12-31T20:00:00` | `2019-12-31` | `20:00:00` |
| `2020-01-01[Asia/Tokyo]` | `2020-01-01T00:00:00` | `2019-12-31T15:00:00` | `2019-12-31` | `15:00:00` |
| `2020-01-01T05:00:00Z[America/New_York]` | `2020-01-01T00:00:00` | `2020-01-01T05:00:00` | `2020-01-01` | `05:00:00` |
| `2020-11-01T01:30:00-04:00[America/New_York]` | `2020-11-01T01:30:00` | `2020-11-01T05:30:00` | `2020-11-01` | `05:30:00` |
| `2020-11-01T01:30:00-05:00[America/New_York]` | `2020-11-01T01:30:00` | `2020-11-01T06:30:00` | `2020-11-01` | `06:30:00` |

The last two rows are the repeated hour when daylight saving time ends. They are different instants that currently store the same value.

TIMESTAMP, which the original ticket did not list, has the same defect. `'2020-01-01T00:00:00-05:00[America/New_York]'` stores `1577836800000` and should store `1577854800000`.

`select id from zn where t = '2020-01-01T05:00:00Z'` also misses today's row. Comparison text goes through the same helper, so `normalizeComparand` and the conversion agree once the helper is fixed.

## Changes

**1. Convert through the instant.** The first branch becomes `Temporal.ZonedDateTime.from(v).toInstant().toZonedDateTimeISO('UTC').toPlainDateTime()`. This is preferred over `withTimeZone('UTC')` because it also drops any calendar annotation, as the offset branch does.

**2. Reject a zone that cannot be resolved.** `2020-01-01T00:00:00[Nowhere/Fake]` fails `ZonedDateTime.from` and `Instant.from`, then `PlainDateTime.from` accepts it and ignores the annotation. The local reading is stored silently, which is the same wrong result. The docs say a `[zone]` annotation is converted, and this input cannot be, so the helper throws before the bare branch.

- Detect the annotation with `/\[!?[^=\]]*\]/`. In the annotation grammar (RFC 9557), a zone annotation has no `=` and a calendar or other tagged annotation always has one, so `[u-ca=hebrew]` does not match.
- A zone name a runtime has no data for takes the same path. From reading the code, not from a run on such a runtime, this rejection also stops a runtime with limited time zone data from storing different values than other platforms.
- `2020-01-01T00:00:00-05:00[Nowhere/Fake]` stays accepted and stores `05:00:00`, because the offset alone names the instant. A contradictory `2020-01-01T00:00:00-08:00[America/New_York]` also stays accepted and stores `08:00:00`. It fails `ZonedDateTime.from` and falls to `Instant.from`, which uses the offset. Say in a comment that this is deliberate.
- `normalizeComparand` already catches the throw and compares the text as text, which `docs/types-ordering.md` § DATETIME against text describes as correct for text naming no instant.

**3. Close the DATE and TIME fallbacks,** which would otherwise accept what the helper now rejects:

- **DATE:** remove the `Temporal.PlainDate.from` fallback from `validate` and `parse`. `PlainDate.from` and `PlainDateTime.from` gave the same accept or reject result on all 12 spellings tried, including `20200101`, `+002020-01-01`, `2020-01-01T10`, `2020-01` and `2020-01-01Z`, so bare dates still parse through the helper. The existing comment saying the helper rejects bare dates is wrong and goes with it. Keep the `Cannot convert to DATE` error text, which tests match on.
- **TIME:** keep the `PlainTime.from` fallback for time-only text, but refuse text carrying a zone annotation or an offset. `docs/types.md` says TIME accepts a bare time or a datetime, yet `10:30:00[America/New_York]` and `10:30:00-05:00` are both accepted today and stored as `10:30:00`. Without a date, a named zone has no offset to apply, so rejection is the only correct result for that form. Reject the offset form too, so that one rule covers both. No test or doc example uses either spelling. `2020-01-01T00:00:00[Nowhere/Fake]` also reaches this fallback and is rejected by the same check. Share one small predicate between `validate` and `parse`.

**4. Drop calendar annotations on the bare branch.** Calling `Temporal` directly shows `PlainDateTime.from('2020-01-01T00:00:00[u-ca=hebrew]').toString()` keeps the annotation, so a DATETIME would store text that is not the documented bare form. Add `.withCalendar('iso8601')` to the helper's final branch. This also covers DATE input such as `2020-01-01[u-ca=hebrew]` once the DATE fallback is gone.

## Rows already stored

The fix corrects new writes only. A row already stored from a zone-annotated input holds the local reading, and the zone is not recoverable from the stored value, so no migration can repair it. Canonical stored text parses back unchanged, so rereading an old row does not shift it a second time. After the fix, a key column can hold both an old local reading and a new UTC reading for what was once the same input. State this in the review handoff.

## Tests

Add one section to `98-temporal-edge-cases.sqllogic`, using the values in the table. It is the reproduction of this bug, so it should fail before change 1. Cover these behaviours once each:

- All four column types convert a named-zone input.
- The no-offset form resolves its zone.
- The repeated-hour pair stores two distinct values.
- `where t = '2020-01-01T05:00:00Z'` finds the row.
- An unknown zone errors on insert for each of DATE, TIME and DATETIME, using the existing `-- error: Cannot convert` form.
- Time-only input with a zone or an offset errors.

The zone data comes from the runtime, but the file already runs on Node, so no platform guard is needed.

Run with `yarn workspace @quereus/quereus run test --grep "98-temporal"`, which passes at HEAD, then run `yarn test`. Zone handling does not differ by storage module, so `yarn test:store` is not needed.

## Documentation

- `docs/types.md`: DATE gains the note that the stored date is the UTC date, so `2020-01-01[Asia/Tokyo]` stores `2019-12-31`. All three types state that an unresolvable zone is rejected. TIME states that time-only text must be bare. DATETIME's validation bullet says a `Temporal.PlainDateTime` parse is enough, and that no longer holds for annotated text.
- `docs/datetime.md`, "Canonicalization for stored column values": the paragraph saying comparison literals are compared raw is stale for DATETIME. The `dt_filter` cases in the logic test show the opposite, and `docs/types-ordering.md` § DATETIME against text is the correct description. Limit the raw-comparison claim to DATE and TIME and link to that section for DATETIME.
- Update the helper's doc comment to describe the instant conversion and the rejection.

## TODO

- Add the failing logic test section and confirm it fails on the named-zone cases
- Change the helper's first branch to convert through the instant
- Add the unresolvable-zone rejection and the bare-branch `withCalendar('iso8601')`
- Remove the DATE fallback, and restrict the TIME fallback to bare time-only text
- Update `docs/types.md`, `docs/datetime.md` and the helper comment
- Run the targeted test and `yarn test`, and `yarn lint` for the `packages/quereus` type pass
- In the review handoff, state that existing rows are not corrected and that time-only offsets are now rejected
