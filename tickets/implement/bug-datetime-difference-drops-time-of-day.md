description: Subtracting one timestamp from another reports only the whole days between them and silently throws away the hours, minutes, and seconds — so two moments five days and two hours apart come back as exactly five days. Make the answer carry the full elapsed gap.
architecture: docs/types.md#temporal-types
files:
  - packages/quereus/src/types/temporal-ops.ts                                   # asPlainDate + dateDifference — the one site that drops the time of day
  - packages/quereus/test/logic/107-temporal-arithmetic-mutation-kills.sqllogic  # four assertion sites lock the old answers
  - packages/quereus/test/runtime/temporal-arithmetic.spec.ts                    # two mixed-form assertions lock the old answers
  - packages/quereus/test/types/temporal-ops.spec.ts                             # home for the new round-trip property test
  - docs/types.md                                                                # temporal arithmetic table + the bullet that documents the loss
repro: verified
difficulty: easy
----

# Root cause

One helper. `packages/quereus/src/types/temporal-ops.ts:195` converts **both** operands of a `-` between DATE/DATETIME values to a `Temporal.PlainDate` before taking the difference:

```ts
function asPlainDate(v: SqlValue, kind: 'date' | 'datetime'): Temporal.PlainDate {
	return kind === 'datetime'
		? Temporal.PlainDateTime.from(v as string).toPlainDate()   // <- time of day discarded here
		: Temporal.PlainDate.from(v as string);
}
```

`dateDifference` (line 209) then does `asPlainDate(v1, lk).since(asPlainDate(v2, rk))`, and all four `-` cases in the table — `date|date`, `date|datetime`, `datetime|date`, `datetime|datetime` — are built from it. Both the value-sniffed path (`tryTemporalArithmetic`) and the emit-time specialized path run the same `apply`, so fixing the helper fixes every call site; nothing else in the runtime or planner needs to change. The announced result type is already TIMESPAN and stays TIMESPAN.

Verified against the current build (node against `packages/quereus/dist`, via `db.get`):

```
datetime('2024-01-20T10:00:00') - datetime('2024-01-15T08:00:00')  =>  "P5D"    (should be P5DT2H)
date('2024-01-25')              - datetime('2024-01-15T10:00:00')  =>  "P10D"   (should be P9DT14H)
datetime('2024-01-25T10:00:00') - date('2024-01-15')               =>  "P10D"   (should be P10DT10H)
date('2024-01-25')              - date('2024-01-15')               =>  "P10D"   (correct, unchanged)
```

# The ruling (already settled — do not re-open it)

Carried over from the fix ticket, which carried it from the backlog garden pass:

- A plain DATE on either side of `-` against a DATETIME is read as **that date at midnight** (`Temporal.PlainDate.from(v).toPlainDateTime()` with no time argument).
- All three cases involving a DATETIME produce the **full elapsed duration**, days plus time of day.
- `DATE - DATE` is **unchanged**: there is no time of day to lose, and keeping it on `PlainDate.since` keeps that case's intent legible. It would produce the same string either way — both sides are midnight — so a single unified PlainDateTime implementation is equally acceptable if it reads better; the observable answers are identical.

The largest unit stays `day`. `Temporal.PlainDateTime.prototype.since` defaults to `largestUnit: 'day'`, so results are shaped `P10DT2H15M` and never introduce years, months or weeks. That matters downstream: `hasCalendarUnits` in the same file treats days as non-calendar, so `TIMESPAN / TIMESPAN` ratios, `TIMESPAN_TYPE.compare` and `TIMESPAN_TYPE.groupKey` all keep working on the new values with no change.

# Expected answers after the fix

Computed directly from `temporal-polyfill` — these are the exact strings the assertions should carry:

| expression | before | after |
|---|---|---|
| `datetime('2024-01-20T10:00:00') - datetime('2024-01-15T08:00:00')` | `P5D` | `P5DT2H` |
| `datetime('2024-01-15T08:00:00') - datetime('2024-01-20T10:00:00')` | `-P5D` | `-P5DT2H` |
| `date('2024-01-25') - datetime('2024-01-15T10:00:00')` | `P10D` | `P9DT14H` |
| `datetime('2024-01-25T10:00:00') - date('2024-01-15')` | `P10D` | `P10DT10H` |
| `datetime('2024-01-15T12:00:00') - datetime('2024-01-15T12:00:00')` | `PT0S` | `PT0S` (unchanged) |
| `datetime('2024-01-25T00:00:00') - datetime('2024-01-15T00:00:00')` | `P10D` | `P10D` (unchanged) |
| `datetime('2024-01-16T01:00:00') - datetime('2024-01-15T23:00:00')` | `P1D` | `PT2H` |
| `datetime('2024-01-15T00:00:00.500') - datetime('2024-01-15T00:00:00')` | `PT0S` | `PT0.5S` |
| `date('2024-01-25') - date('2024-01-15')` | `P10D` | `P10D` (unchanged) |

# Assertion sites that lock the old behavior

A board-wide grep found no other open ticket touching these files. Every site below currently asserts the buggy answer and must be updated in the same change, or the suite goes red.

**`packages/quereus/test/logic/107-temporal-arithmetic-mutation-kills.sqllogic`**

- Around line 132: `date('2024-01-25') - datetime('2024-01-15T10:00:00')` → `P9DT14H`.
- Around line 135: `datetime('2024-01-25T10:00:00') - date('2024-01-15')` → `P10DT10H`.
- Around lines 399–408: the whole `-- DATETIME - DATETIME drops the time of day` block. Its comment says the loss is preserved-as-found and names this ticket; delete the comment, keep the query, and change the expectation to `P5DT2H`. Retitle the block to say what it now pins — that the time of day survives the difference.
- Around lines 655–658: the `arms2` column-driven mixed differences, whose comment reads "all collapse to whole days". With `dtm = '2024-01-20T08:15:00'`, `dtm2 = '2024-01-10T06:00:00'` and `dt = '2024-01-15'`, the row becomes `{"a":"P10DT2H15M","b":"P5DT8H15M","c":"P4DT18H"}`. Drop the comment's claim and its pointer to the removed `dateDifference` NOTE.

The literal-expression cases around lines 117–127 (`PT0S`, and midnight-to-midnight `P10D`) keep their values; leave them and add the new cases beside them.

**`packages/quereus/test/runtime/temporal-arithmetic.spec.ts`**

- Line 165 (`date - datetime`): `'P10D'` → `'P9DT14H'`.
- Line 168 (`datetime - date`): `'P10D'` → `'P10DT10H'`.
- Line 155's inline comment `// Date-level subtraction (time component is stripped to date)` is now false — remove it. The assertion below it (midnight to midnight) keeps `'P10D'`.

`packages/quereus/test/logic/98-temporal-edge-cases.sqllogic` was named in the fix ticket but contains no date/datetime difference at all — a grep over it finds only `date(...)` / `datetime(...)` conversions. Nothing to change there.

# New coverage

The reason this went unnoticed is that the mutation-kill file covered `DATE - DATE` and `TIME - TIME` but never subtracted two DATETIMEs with *different* times of day. Add, in `107-temporal-arithmetic-mutation-kills.sqllogic` alongside the existing `DATETIME - DATETIME` block: a positive gap with a time remainder, its negative mirror, a pair less than a day apart that crosses midnight (so the answer is `PT2H`, not `P1D`), and a sub-second gap. Matching unit cases go in `temporal-arithmetic.spec.ts`.

**Generalized test — the rung above the point cases.** One property covers the whole class and keeps covering it after future edits to the table: for any two DATETIME values `a` and `b`, `b + (a - b)` must equal `a`, because the difference is exactly the gap and adding it back lands on the original instant. That property is false today — it is precisely what this bug breaks — and true after the fix; measured over 2000 random pairs spanning years 2000–2049 at millisecond precision, 0 mismatches under the corrected implementation. `fast-check` is already a dev dependency and already used in `packages/quereus/test/property.spec.ts`, so this can be an `fc.property` over two generated datetimes. Put it in `packages/quereus/test/types/temporal-ops.spec.ts`, which owns the table, and drive it through `temporalOpCase('-', 'datetime', 'datetime')` and `temporalOpCase('+', 'datetime', 'timespan')` so it exercises the table rather than a re-implementation of it.

The property deliberately does **not** extend to the mixed forms: `date + timespan` truncates any sub-day part, so `b + (a - b)` cannot round-trip when `b` is a DATE. Keep the property on the `datetime|datetime` case and leave the mixed forms to the point cases above.

# Docs

`docs/types.md`, in the temporal arithmetic material under "Temporal Types" (the operator table starts around line 508):

- The bullet at lines 526–528 currently documents the loss and points at this ticket's slug. Replace it with the ruling: a DATE/DATETIME difference reports the full elapsed gap, and a DATE facing a DATETIME is read as that date at midnight. Keep an example — `datetime('2024-01-20T10:00:00') - datetime('2024-01-15T08:00:00')` is `P5DT2H` — so the corrected behavior is stated as concretely as the bug was.
- The operator table row for `-` over DATE/DATETIME stays as-is; the result's *meaning* changed, not its type.
- Worth one clause where the ruling lands: the result never carries years, months or weeks, so it stays comparable and divisible.

# Behavior change, stated plainly

This changes the answer of an operator people may already have built around. That was weighed and accepted when the ticket was promoted: a whole-days answer to "how far apart are these two timestamps" is wrong, and wrong silently, because `P5D` is a perfectly valid duration. Anyone who wants the calendar-day count can still write `date(a) - date(b)`, which is unchanged and now reads as the deliberate choice it is. Say so in the handoff to review; no migration note or compatibility shim is expected.

# TODO

- [ ] Replace `asPlainDate` with a PlainDateTime-producing helper (a DATE becomes `Temporal.PlainDate.from(v).toPlainDateTime()`), and have `dateDifference` take the difference at datetime resolution for the three cases involving a DATETIME. Keep `date|date` on `PlainDate.since`.
- [ ] Delete the `NOTE:` on `dateDifference` (`temporal-ops.ts`, lines ~202–208) that documents the loss and names this ticket's slug — it is stale the moment the fix lands.
- [ ] Update the four assertion sites in `107-temporal-arithmetic-mutation-kills.sqllogic` and the two in `temporal-arithmetic.spec.ts` to the values in the table above, removing the three comments that assert the loss is intentional.
- [ ] Add the new point cases — negative gap, sub-day gap crossing midnight, sub-second gap — in both the sqllogic file and the unit spec.
- [ ] Add the `fast-check` round-trip property (`b + (a - b) == a` for DATETIME pairs) to `packages/quereus/test/types/temporal-ops.spec.ts`, driven through `temporalOpCase` rather than a re-implementation.
- [ ] Update `docs/types.md`: replace the "collapses to a calendar date" bullet with the ruling, and drop the ticket-slug reference.
- [ ] Run `yarn workspace @quereus/quereus test` and `yarn lint`; confirm no other suite was pinning a whole-days difference.
