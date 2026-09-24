description: Subtracting one timestamp from another used to report only whole days and silently drop the hours, minutes and seconds; it now reports the full elapsed gap (for example five days and two hours). Fixed, reviewed, and covered by tests.
architecture: docs/types.md#temporal-types
files:
  - packages/quereus/src/types/temporal-ops.ts                                   # asPlainDateTime + dateDifference — the fixed site
  - packages/quereus/test/logic/107-temporal-arithmetic-mutation-kills.sqllogic  # updated assertions, new point cases
  - packages/quereus/test/runtime/temporal-arithmetic.spec.ts                    # updated assertions, new unit cases
  - packages/quereus/test/types/temporal-ops.spec.ts                             # three properties over the four difference arms
  - docs/types.md                                                                # temporal arithmetic notes
repro: verified
----

# What landed

`asPlainDate` (which discarded a DATETIME's time of day) became `asPlainDateTime`: a DATETIME is kept as-is, a DATE is read as that date at midnight. `dateDifference` runs `PlainDateTime.since` for all four `-` arms in the operation table (`date|date`, `date|datetime`, `datetime|date`, `datetime|datetime`), so a difference is the full elapsed gap. The largest unit stays `day`, so a result never carries years, months or weeks.

One code site, one behavior. `datetime('2024-01-20T10:00:00') - datetime('2024-01-15T08:00:00')` is `P5DT2H` where it was `P5D`; `date('2024-01-25') - date('2024-01-15')` is still `P10D`. The calendar-day count remains available as `date(a) - date(b)`.

The behavior change was deliberate and taken without a compatibility shim — weighed and accepted when the ticket was promoted. `docs/types.md` states the new semantics and points at `date(a) - date(b)`.

# Review findings

## Checked, nothing found

- **Every expected value recomputed by hand**, including the column-driven `arms2` row that exercises the emit-time specialized path (`P10DT2H15M`, `P5DT8H15M`, `P4DT18H`) — all correct.
- **One site, no duplicate to drift.** Grepped `.since(` / `.until(` / `toPlainDate()` across every package's `src/`: `dateDifference` is the only date-difference implementation in the engine, and both the value-sniffed path (`tryTemporalArithmetic`) and the emit-time specialized path run the same `apply`.
- **Nothing else pinned a whole-days difference.** Grepped every duration literal (`"P<n>D"`, `'P<n>D'`, `P<n>DT…`) across all `.sqllogic` and `.ts` in the repo. Remaining hits are `timespan(...)` constructions, stored TIMESPAN column values, and `DATE - DATE` — all unchanged by this fix.
- **No stale references to the old behavior or to this ticket's slug** anywhere in tracked source; the one hit is in `packages/quereus/dist/`, which is gitignored build output.
- **TIMESPAN ordering and grouping are unaffected.** `TIMESPAN_TYPE.compare` and `groupKey` both resolve through `timespanTotalSeconds` against a fixed reference date, so `P5DT2H` ranks and hashes by elapsed time exactly as the old day-only shapes did.
- **Docs read end to end, not assumed.** `docs/types.md` § temporal arithmetic, `docs/datetime.md`, `docs/functions.md`, `docs/sql-functions.md`, and the temporal rows of `docs/runtime.md`. Only `types.md` made the whole-days claim, and it is rewritten correctly.
- **Aspect sweep clean.** Nothing is allocated or held, `runTemporalCase`'s null / malformed-value envelope is untouched, no `any`, no widened public surface. `temporal-ops.ts` is 419 lines (`wc -l`) — no size debt. Comments at the site say why, not what.
- **Polyfill behavior probed rather than assumed** (throwaway script, deleted): `PlainDateTime.since` really does default to a largest unit of `day` across a multi-year gap, and `PlainDate.add(P5DT2H)` truncates to `2024-01-06` rather than throwing.

## Minor — fixed in this pass

- **The two mixed arms had no property coverage, and the handoff declared that impossible.** It is not: the round-trip pins `datetime|datetime` exactly, and a midnight-equivalence property carries that strength across to `date|datetime` and `datetime|date`. Added `a DATE operand reads as exactly that date at midnight, on either side`. Mutation-checked — collapsing *only* the mixed arms to date resolution fails it (`2000-01-01 - 2000-01-01T00:00:00.001: expected 'PT0S' to equal '-PT0.001S'`) while the round-trip property passes, so the gap was real and is now closed.
- **"Never carries years, months or weeks" was asserted in two places and pinned in none** — and it is load-bearing, not cosmetic: `timespanRatio` returns NULL and `divideTimespanByNumber` truncates the moment a duration carries calendar units, so a years-shaped difference would silently break `(a - b) / (c - d)` on any gap over a year. Every existing case was 29 days or shorter. Added a property over all four arms, a unit point case, and two sqllogic cases (the `P411DT2H` gap and the `/ timespan('PT1H')` ratio that would have gone NULL). Mutation-checked with `{ largestUnit: 'year' }`: fails on `2000-01-01 - 2000-02-01 = -P1M`.
- **Sub-millisecond precision was a declared gap** (the property fuzzes at millisecond resolution). Added a nanosecond point case: `datetime('2024-01-15T00:00:00.000000001') - datetime('2024-01-15T00:00:00')` is `PT0.000000001S`.
- **`dateDifference`'s JSDoc stated the largest-unit-day fact without saying why it matters.** Extended it to name the two consumers that degrade on calendar units, so a future edit sees the cost before changing it.

## Major — none

Nothing reached the filing bar, and no ticket was filed. The fix is a four-line semantic correction at a single site with no architectural seam behind it, and the class-level invariant that retires the whole bug class — "the difference is exactly the gap" — is now expressed as a property test rather than a point assertion, which is rung 2 of the ladder rather than a point ticket.

## Tripwire recorded

- **Wall-clock versus instant semantics.** `PlainDateTime.since` measures elapsed wall-clock time, not a difference of instants. DATETIME values are stored UTC-canonicalized (`parseDateTimeStringToUtcPlain`), so today the two coincide; if a zoned datetime type ever lands, this case has to subtract instants or it will misreport gaps across a daylight-saving shift. Parked as a `NOTE:` on `dateDifference` in `packages/quereus/src/types/temporal-ops.ts` — not a ticket, because it is only work if zoned datetimes appear.

## Considered and declined

- **`DATE + (DATETIME - DATETIME)` silently truncates the sub-day remainder.** Newly reachable, since differences now carry a time of day — but it is the same truncation `date('2024-01-15') + timespan('PT30M')` already has, a DATE having no time of day to keep it in. Already documented in `docs/types.md` and pinned in `107-temporal-arithmetic-mutation-kills.sqllogic` (the `sp2 + dt` case). Left alone.
- **`yarn test:store` deliberately not run.** Temporal arithmetic is scalar value-layer evaluation (`types/temporal-ops.ts` into `runtime/emit/binary.ts`); it touches no storage, key encoding, or transaction code, and the store suite re-runs the same logic files against a different backend. Skipped on purpose, not overlooked.

## Validation

`yarn lint` clean across every workspace (eslint plus the `tsconfig.test.json` type pass for `@quereus/quereus`). `yarn test` — every workspace — green: `@quereus/quereus` 10438 passing, 25 pending, 0 failing (up 4 from the handoff's 10434, exactly the four `it`s added), all other workspaces passing. No pre-existing failures surfaced, so nothing was written to `tickets/.pre-existing-error.md`.
