description: Subtracting one timestamp from another used to report only whole days and silently drop the hours, minutes and seconds; it now reports the full elapsed gap (for example five days and two hours). The fix is in and the test suite passes — this ticket asks for a review pass over it.
architecture: docs/types.md#temporal-types
files:
  - packages/quereus/src/types/temporal-ops.ts                                   # asPlainDateTime + dateDifference — the fixed site
  - packages/quereus/test/logic/107-temporal-arithmetic-mutation-kills.sqllogic  # four old assertions updated, new point cases added
  - packages/quereus/test/runtime/temporal-arithmetic.spec.ts                    # two old assertions updated, new unit cases added
  - packages/quereus/test/types/temporal-ops.spec.ts                             # new round-trip property test
  - docs/types.md                                                                # temporal arithmetic notes, bullet on the difference rewritten
repro: verified
----

# What changed

`packages/quereus/src/types/temporal-ops.ts`: `asPlainDate` (which discarded the time of day from a DATETIME) became `asPlainDateTime`, which keeps a DATETIME as-is and reads a DATE as that date at midnight (`Temporal.PlainDate.from(v).toPlainDateTime()`). `dateDifference` now takes `PlainDateTime.since` for all four `-` cases in the table (`date|date`, `date|datetime`, `datetime|date`, `datetime|datetime`). The stale `NOTE:` that documented the loss and named this ticket's slug is gone.

The ticket allowed either keeping `date|date` on `PlainDate.since` or unifying on datetime resolution; I unified, since both sides are midnight for `DATE - DATE` and the answers are identical (`P10D`, `PT0S`). The largest unit stays `day` (the default of `PlainDateTime.since`), so results are shaped `P5DT2H` and never carry years, months or weeks — `TIMESPAN / TIMESPAN`, `TIMESPAN_TYPE.compare` and `groupKey` were not touched and are unaffected.

# Behavior change (deliberate, no shim)

Anyone who built on `datetime - datetime` returning whole days now gets the full gap. That was weighed and accepted when the ticket was promoted. The calendar-day count is still available as `date(a) - date(b)`, which is unchanged; `docs/types.md` says so.

# What to check in review

Before → after, all confirmed by the updated tests:

| expression | before | after |
|---|---|---|
| `datetime('2024-01-20T10:00:00') - datetime('2024-01-15T08:00:00')` | `P5D` | `P5DT2H` |
| `datetime('2024-01-15T08:00:00') - datetime('2024-01-20T10:00:00')` | `-P5D` | `-P5DT2H` |
| `date('2024-01-25') - datetime('2024-01-15T10:00:00')` | `P10D` | `P9DT14H` |
| `datetime('2024-01-25T10:00:00') - date('2024-01-15')` | `P10D` | `P10DT10H` |
| `datetime('2024-01-16T01:00:00') - datetime('2024-01-15T23:00:00')` | `P1D` | `PT2H` |
| `datetime('2024-01-15T00:00:00.500') - datetime('2024-01-15T00:00:00')` | `PT0S` | `PT0.5S` |
| `date - date`, midnight-to-midnight, same-instant | unchanged | unchanged |

Column-driven mixed differences (the emit-time specialized path, `arms2` in the sqllogic file): `dtm - dtm2`, `dtm - dt`, `dt - dtm2` → `P10DT2H15M`, `P5DT8H15M`, `P4DT18H`. Both the value-sniffed path (`tryTemporalArithmetic`) and the specialized path run the same `apply`, so one fix covers both.

# Tests

- Updated the assertions that locked the old answers: four sites in `107-temporal-arithmetic-mutation-kills.sqllogic` (mixed forms, the `DATETIME - DATETIME drops the time of day` block — retitled and its comment removed — and the `arms2` row) and two in `temporal-arithmetic.spec.ts`; removed the false "time component is stripped to date" comment.
- New point cases in both files: positive gap with a time remainder, its negative mirror, a sub-day gap across midnight (`PT2H`), a sub-second gap (`PT0.5S`), and an explicit `date - date` staying whole days.
- New property in `test/types/temporal-ops.spec.ts` (`datetime difference round-trip`): for two random DATETIMEs over 2000–2049 at millisecond precision (500 runs), `b + (a - b)` equals `a`, driven through `temporalOpCase('-', 'datetime', 'datetime')` and `temporalOpCase('+', 'datetime', 'timespan')` rather than a re-implementation. Instants are compared via `Date.parse` because the table renders a whole second without a fraction. I mutation-checked it: with `asPlainDateTime` temporarily changed to drop the time of day, the property fails on its first shrink (`…00.001 + (…00.000 - …00.001)` returns `…00.001`), then I restored the source.
- `yarn workspace @quereus/quereus test`: 10434 passing, 25 pending, 0 failing. `yarn lint`: clean.

# Known gaps (reviewer: treat the tests as a floor)

- The property covers `datetime|datetime` only. It cannot extend to the mixed forms — `date + timespan` truncates any sub-day part, so a DATE subtrahend cannot round-trip — so `date|datetime` and `datetime|date` rest on the point cases.
- The property runs at millisecond precision. Microsecond/nanosecond DATETIME strings go through the same `Temporal` arithmetic and were not fuzzed.
- `yarn test:store` (LevelDB store path) was not run; this change is in the value layer below the storage module, but I did not confirm it.
- Only `@quereus/quereus` was tested. I grepped the repo for the old phrasing and assertion values and found nothing else pinning a whole-days difference, but the other workspaces' suites were not run.
- No timezone or DST cases exist (or apply): `PlainDateTime` is wall-clock, so the gap is wall-clock elapsed time, not an instant difference. That matches how DATETIME values are stored, but it is a semantic worth a second look if zoned datetimes ever appear.
