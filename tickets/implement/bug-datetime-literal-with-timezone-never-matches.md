---
description: A stored date-and-time cannot be found by searching for the text that created it, because writes convert text to one standard spelling and comparisons do not. Make comparisons convert the text the same way, so a timestamp ending in Z or an offset finds its row and sorts correctly.
architecture: docs/types.md
files:
  - packages/quereus/src/types/logical-type.ts              # new optional hook on LogicalType
  - packages/quereus/src/types/temporal-types.ts            # DATETIME implements the hook
  - packages/quereus/src/types/cast-semantics.ts            # comparand conversion, beside lenientCast
  - packages/quereus/src/types/comparison-coercion.ts       # the decision: crossTypeCoercion, comparisonGroupCoercions
  - packages/quereus/src/runtime/emit/cast.ts               # synthetic casts run the comparand conversion
  - packages/quereus/src/runtime/emit/operand-comparator.ts # makeComparisonGroup key (nullif, greatest, least)
  - packages/quereus/src/runtime/emit/subquery.ts           # inMembershipKeys (IN over a subquery)
  - packages/quereus/src/runtime/emit/temporal-arithmetic.ts # comment correction only
  - packages/quereus/src/func/builtins/conversion.ts        # datetime('now') returns a Z spelling
  - packages/quereus/test/logic/15.1.3-declared-form-write-contract.sqllogic # scope note names this ticket
  - docs/types.md                                           # DATETIME section, comparison coercion section, two-families paragraph
difficulty: medium
repro: verified
---

# Comparing a DATETIME against text must normalize the text the way a write does

## Decisions already made (maintainer, 2026-11-03)

These are settled; do not reopen them.

- DATETIME is a fixed instant. The stored spelling stays bare UTC (`2020-01-01T00:00:00`), so no persisted value or downstream content digest changes.
- Comparing a DATETIME against text normalizes that text the way a write does. Text that does not parse compares exactly as it does today, as plain text.
- The variadic `datetime(x, modifier…)` family keeps its display spelling and its TEXT return type (Arm B, option 3). `docs/types.md` and `func/builtins/datetime.ts` already record this.
- A shape check on a `datetime` column sees the canonical spelling. This gets a documentation note, not a new diagnostic (Arm C). GitHub issue #28 stays rejected.

## What is wrong

Writes convert text through `DATETIME_TYPE.parse`. Comparisons never do, because `crossTypeCoercion` (`types/comparison-coercion.ts`) has no arm for DATETIME against text, and `tryTemporalCompare` only handles TIMESPAN. The comparison therefore runs as binary text between the stored bare spelling and whatever the query spelled. `docs/types.md` § DATETIME already promises "Equal instants compare equal regardless of input shape", so this is the code failing the documented rule.

Reproduced against the v4.25.0 build, over rows inserted as `(1, '2020-01-01T00:00:00Z')` and `(2, '2021-06-05T10:00:00+02:00')`. The results were identical for an unindexed column, a secondary index and a primary key:

| Query against `t datetime` | Today | Expected |
|---|---|---|
| `t = '2020-01-01T00:00:00Z'` | no rows | 1 |
| `t = '2021-06-05T10:00:00+02:00'` | no rows | 2 |
| `t >= '2021-06-05T09:00:00+02:00'` | no rows | 2 |
| `t < '2021-06-05T09:00:00+02:00'` | 1, 2 | 1 |
| `t between '2021-06-05T09:00:00+02:00' and '2021-06-05T11:00:00+02:00'` | no rows | 2 |
| `t in ('2020-01-01T00:00:00Z', '2021-06-05T10:00:00+02:00')` | no rows | 1, 2 |
| `t in (select x from s)`, where `s.x` holds the offset spelling | no rows | 2 |
| `t = ?` bound to `'2020-01-01T00:00:00Z'` | no rows | 1 |
| `t >= :p` bound to the offset spelling | no rows | 2 |
| `join s on a.t = s.x` | no rows | row 2 pairs with `s` row 1 |
| `case t when '2020-01-01T00:00:00Z' then 'y' else 'n' end` | n, n | y, n |
| `nullif(t, '2020-01-01T00:00:00Z')` | row 1 not nulled | row 1 is NULL |
| `greatest(t, '2021-06-05T09:00:00+02:00')` on row 2 | returns the literal | returns the stored `t`, which is the later instant |
| `t = datetime('2020-01-01 00:00:00', '+0 days')` | no rows | 1 |
| `t = '2020-01-01'` | no rows | 1 |
| `t = '2020-01-01T00:00:00.000'` | no rows | 1 |
| `datetime('2020-01-01T00:00:00Z') = '2020-01-01T00:00:00Z'` | false | true |
| `any_col = t`, with the offset spelling in the `any` column | no rows | matches |
| `check (t >= '2020-01-01T00:00:00Z')` inserting that exact value | constraint fails | passes |

These must stay as they are:

| Query | Result |
|---|---|
| `t = 'garbage'` | no rows |
| `t < 'garbage'` | all rows (plain text order) |
| `t > 'garbage'` | no rows |
| `t = ?` bound to the number `1577836800000` | no rows; only text normalizes, a number is not read as an epoch |

### Storing `datetime('now')` writes a `Z` into the column

This one was not in the original report. `select datetime('now')` returned `2026-11-04T07:29:34.527Z`, and `insert into sn values (2, datetime('now'))` stored that exact text, `Z` included. Every other write stores the bare form.

The ticket's earlier notes blamed the variadic family, but a one-argument call dispatches to `DATETIME_FUNC` in `func/builtins/conversion.ts`. Its `now` branch returns `new Date().toISOString()` while announcing DATETIME. The write path sees a matching type, and the value passes DATETIME's `validate`, so conversion is skipped. Changing the branch to return `DATETIME_TYPE.parse!(new Date().toISOString())` fixes both storing and comparing.

`select datetime('now')` then prints without the `Z`, which is what the stored-spelling decision requires. Rows already written this way keep their `Z`: nothing migrates them, and they will not match a normalized comparison exactly. `update t set c = datetime(c)` rewrites them. Say so in the docs.

## Approach

Reuse the existing comparison coercion rather than adding a second mechanism. `crossTypeCoercion` already decides which operand converts for every comparison site: `=` and friends, BETWEEN, IN lists, simple CASE, USING, subquery decorrelation, and the emit-time key for `nullif`/`greatest`/`least`.

**A plain `CastNode` to DATETIME cannot be reused as it stands.** `lenientCast` falls back to NULL for unparseable text (`castFallback`'s default arm), which would turn `t < 'garbage'` from all rows into no rows and violate the decision. A cast also parses numbers as epoch milliseconds, which would make `t = 1577836800000` start matching. User-written `cast('junk' as datetime)` must stay NULL.

So:

- Add an optional hook to `LogicalType`, for example `normalizeComparand?(value: SqlValue): SqlValue`: convert a comparison operand to the type's stored spelling, and return anything else unchanged. Its presence is what opts a type in. DATETIME implements it as "a string goes through `parse`; on a parse failure or a non-string, return the value as given". Only DATETIME gets it in this ticket (see the blocked ticket `date-time-timestamp-comparisons-against-text`).
- Add a function beside `lenientCast` in `types/cast-semantics.ts` that uses the hook when the target has one and otherwise calls `lenientCast`. `buildCastSpec` uses it when `plan.synthetic` is true, so user-written casts keep today's behaviour. `makeComparisonGroup` and `inMembershipKeys` use it too.
- Add an arm to `crossTypeCoercion`, after the object arm: if one side has the hook and the other is `isTextual` or `ANY_TYPE`, the other side converts. `ANY` is required because an untyped `?` announces ANY, and a bound parameter is the most common way an application hands in a timestamp. A NULL-typed operand stays alone.
- Extend `comparisonGroupCoercions`. A probe with the hook converts each textual or ANY value independently, as the numeric probe arm does. A textual or ANY probe against values that are all the hook type converts once. A probe against a list mixing DATETIME and text stays unconverted, the same documented gap the numeric arm has: hoisting would make `text_col in (dt_col, '…Z')` miss an exact text match that the `=` disjunction finds. Record it in the existing `NOTE`.
- Add the same pairing to `inMembershipKeys`, where only the non-DATETIME side converts.

### What was checked and what to expect

**Index seeks keep working.** Explicit casts stood in for the new synthetic ones, and the planner folds a cast over a literal into a literal:

- `t = cast('2020-01-01T00:00:00Z' as datetime)` planned `INDEX SEEK` with the literal `'2020-01-01T00:00:00'`.
- `>=` and BETWEEN planned `INDEX RANGE` with normalized bounds, and an IN list planned `INDEX SEEK`.
- `t = cast(? as datetime)` planned `INDEX SEEK` with the cast kept in the key.

The synthetic form has not been run yet; confirm it the same way.

**Mixed joins lose the hash join.** `di.t = s.x` plans a hash join today. Wrapping `s.x` in a cast takes the pair out of `extractEquiPairs` and into the join's residual, the same outcome the JSON and numeric arms have. `di.t = cast(s.x as datetime)` planned as a plain `JOIN ON condition`. Same-type DATETIME joins are unaffected. Leave a `NOTE:` at the new `crossTypeCoercion` arm: fine now; if joining DATETIME to text shows up as slow, canonicalize the key instead.

**Per-row cost when the text side is not constant.** `DATETIME_TYPE.parse` measured 11–14 µs per call over 20,000 calls in node, for bare, `Z`, offset and unparseable text alike, because `parseDateTimeStringToUtcPlain` throws its way through up to three parsers. Literals fold, so they pay nothing per row. A seek key pays once per seek. A text column, or an unindexed `t = ?` filter, pays per row. For scale, `comparison.ts` records one comparison expression at about 210–226 ns per row.

Measure an unindexed `t = ?` scan after the change. If it is a meaningful regression, add a one-entry memo in the synthetic cast's closure (same input string, same output), since a parameter repeats one string for the whole scan. Otherwise record the cost as a `NOTE:` at the hook.

**Other behaviour to expect:**

- `t between '2021-01-01' and '2022-01-01'` now includes a row at exactly midnight on 2022-01-01, because the bound normalizes to `2022-01-01T00:00:00`. Text order excluded it. This is the correct reading of the instant.
- The `nullif`/`greatest`/`least` return values stay as written: `greatest(t, '…+02:00')` returns the literal's own spelling when the literal wins, and only the ranking key normalizes. That is the existing contract for builtins that return an argument.
- TIMESPAN keeps its runtime path. `tryTemporalCompare` needs no change.

## GitHub issue #28 (handoff)

Re-verified on this build: `check (ts like '%Z')` on a `datetime` column fails every insert with `CHECK constraint failed`. The issue stays rejected, and **it still needs an answer posted to the reporter, who carries a local patch**. A person posts that, not this ticket. The docs note below is what to point them at.

## TODO

- Add a reproducing logic test as `packages/quereus/test/logic/15.1.4-datetime-comparison-normalization.sqllogic`, built from the two tables above (over an unindexed column, a secondary index and a primary key), plus: storing `datetime('now')` leaves no `Z`, and `cast('junk' as datetime)` is still NULL. Confirm it fails first. Binding parameters needs a spec-level test if the sqllogic format cannot bind; keep it to one test.
- Add the hook, the DATETIME implementation and the comparand conversion.
- Add the `crossTypeCoercion` and `comparisonGroupCoercions` arms, and route `buildCastSpec`, `makeComparisonGroup` and `inMembershipKeys` through the comparand conversion.
- Fix the `now` branch of `DATETIME_FUNC`.
- Confirm by `query_plan` that the synthetic form still folds to a literal and still seeks, including over a parameter.
- Measure the unindexed `t = ?` scan, then either add the memo or leave the `NOTE:`.
- Correct the comments that are now wrong: the `crossTypeCoercion` docblock ("the runtime's `tryTemporalComparison` already reconciles them"), the `tryTemporalComparison` docblock ("DATE, TIME, and DATETIME … compare correctly lexicographically"), and the scope note in `15.1.3-declared-form-write-contract.sqllogic`.
- Update `docs/types.md`:
  - § DATETIME: state the comparison rule, including that unparseable text compares as text and numbers are not normalized. Add the shape-check note: `check (ts like '%Z')` on a `datetime` column fails every insert because the check sees the canonical spelling and the engine owns that spelling; a column that must keep the caller's exact text should be `text`, with `datetime(col)` used to compare it as an instant.
  - § Type Coercion in Comparisons, and the sentence in § JSON saying temporal types keep their runtime path: add the new arm.
  - The two-families paragraph: `datetime('now')` is the one-argument form and returns the canonical spelling. Add the note about rows already stored with a `Z`.
- Run `yarn test` and `yarn lint`. Run `yarn test:store` for this logic file, because seeks over the store encode their keys differently. Expect some existing tests that assert the old mismatch or the `Z` to need updating; check each one against the decisions above before changing it.
