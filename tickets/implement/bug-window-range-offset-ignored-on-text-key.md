---
description: A window frame like "all rows within 10 of the current row's value" silently drops the "within 10" part when the ordering column holds text (or anything non-numeric), answering a different question than was asked; it should raise an error instead, as PostgreSQL and SQLite do.
files:
  - packages/quereus/src/planner/building/select-window.ts      # add the prepare-time check where orderByExpressions are built
  - packages/quereus/src/runtime/emit/window.ts                 # getFrameBounds / rangeOffsetStart / rangeOffsetEnd / rangeOrdinal — runtime check for ANY-typed keys
  - packages/quereus/src/planner/rules/window/rule-monotonic-window.ts  # isRangeSlidingEligible + its doc comment (rationale changes)
  - packages/quereus/src/types/builtin-types.ts                 # ANY_TYPE, NULL_TYPE singletons; LogicalType.isNumeric / isTemporal
  - packages/quereus/test/plan/window-one-sided-frames.spec.ts  # "a non-numeric ORDER BY key keeps every RANGE sliding frame buffered" (line ~269) must change
  - packages/quereus/test/logic/07.5-window.sqllogic            # add error cases next to the existing RANGE offset cases (~line 666-742)
  - docs/window-functions.md                                    # "RANGE vs ROWS" (~line 170), offset paragraph (~line 205), rule-ineligibility list (~line 369)
repro: verified
---

# Reject a numeric RANGE frame offset over a non-numeric ORDER BY key

## Reproduction (verified against the built `dist`)

Table `t(id integer primary key, k text, n integer, a any, d date)` with rows `(1,'a',1,1,'2024-01-01'), (2,'b',2,2,'2024-01-02'), (3,'b',3,'x','2024-01-03')`:

| query | result today | expected |
|---|---|---|
| `count(*) over (order by k range between 1 preceding and 1 following)` | `1,2,2` — identical to `range between current row and current row` | prepare-time error |
| `count(*) over (order by d range between 1 preceding and 1 following)` | `1,1,1` (peer group) | prepare-time error, message says interval offsets are not supported yet |
| `count(*) over (order by a range between 1 preceding and 1 following)` (ANY key, one row holds `'x'`) | `2,2,1` | runtime error when the frame is computed for the `'x'` row |
| `count(*) over (order by n, id range between 1 preceding and 1 following)` | `2,3,2` — offset applied to `n` only, `id` silently ignored | prepare-time error (see "Second arm" below) |

Root cause: nothing validates the frame against the ORDER BY key type. At runtime `rangeOrdinal` (`window.ts`) maps the key through `Number(value)`; text gives `NaN`, and `rangeOffsetStart` / `rangeOffsetEnd` treat a non-finite current value as "peer group", the rule intended for NULL. The streaming path is already kept off these queries by `isRangeSlidingEligible` (`rule-monotonic-window.ts`), so only the buffered walk is involved.

## Decision (maintainer, 2026-11-10)

Raise an error at prepare time. A `range` frame with a numeric `<n> preceding` / `<n> following` bound (start or end) requires a numeric ORDER BY key; any other logical type (text, blob, boolean, temporal) is rejected when the plan is built. Temporal keys are rejected for now, with a message saying an interval offset is not supported yet. An ANY-typed key gets a runtime check when the frame is first computed. `range` frames bounded only by `unbounded` / `current row`, and all `rows` frames, are unchanged.

## Design

**Prepare-time check — `select-window.ts`.** Right after `orderByExpressions` is built for a window spec (inside the `for (const [_windowSpecKey, functions] of windowGroups)` loop), call a small helper, e.g. `validateRangeOffsetFrame(windowSpec.frame, orderByExpressions)`:

- Applies only when `frame?.type === 'range'` and either `frame.start.type` or `frame.end?.type` is `'preceding'` / `'following'`.
- Key type: `orderByExpressions[0].getType().logicalType`.
  - `isNumeric === true` → OK.
  - `ANY_TYPE` (identity, as `isNumericOrUnknownType` in `builtin-types.ts` does) → defer to the runtime check.
  - `NULL_TYPE` (e.g. `order by null`) → recommend allowing: every key is NULL, the frame is the peer group, which is the defined NULL behaviour. Treat like numeric.
  - `isTemporal === true` → error: `RANGE with offset PRECEDING/FOLLOWING over a <type> ORDER BY key requires an interval offset, which is not supported yet`.
  - anything else → error: `RANGE with offset PRECEDING/FOLLOWING requires a numeric ORDER BY key; got <type>`.
- Use `QuereusError` with `StatusCode.ERROR` (an authoring mistake, not a missing feature) for the non-numeric case; `StatusCode.UNSUPPORTED` is reasonable for the temporal case since it may be supported later. Pass the ORDER BY expression's `loc` line/column like `rejectUncollectedAggregates` does.
- The window spec is shared by every function in the group, so one check per group suffices.

**Second arm — ORDER BY key count.** Same site, same condition. A RANGE offset with zero ORDER BY keys or more than one is also meaningless today: `rangeOffsetStart`/`End` read `orderByValues[i][0]` only, so extra keys are silently ignored (repro row 4). With no ORDER BY at all, `orderByValues` rows are empty and `[0]` is `undefined` → `NaN` → peer group = whole partition. PostgreSQL and SQLite both reject both shapes ("requires exactly one ORDER BY column"). Reject them in the same helper. This is outside the letter of the maintainer decision but is the same mistake class (offset arithmetic the engine cannot perform, answered silently with something else) at the same code site; if a reviewer disagrees, drop this arm and file it to backlog instead. Before landing, grep `test/` for any RANGE-offset query with zero or multiple ORDER BY keys that expects a result (none found at fix time with `grep -rn -i "order by [a-z_.]*, *[a-z_.]* range between [0-9]" test`).

**Runtime check for ANY keys — `window.ts`.** `rangeOffsetStart` / `rangeOffsetEnd` currently treat any non-finite current value as peer group. Split that: SQL NULL stays peer group (documented behaviour, see `docs/window-functions.md` ~line 211); a non-null value whose type is not number/bigint raises the same "requires a numeric ORDER BY key" error. The rows-scan loops in those functions skip non-finite `rowVal`; a non-null non-numeric row value elsewhere in the partition should raise too, so the result never depends on which row happens to be current. Simplest: make `rangeOrdinal` throw for non-null, non-numeric values (`typeof v !== 'number' && typeof v !== 'bigint'`) and keep `NULL → NaN`. Prepare-time validation means only ANY keys can reach the throw. Decide whether a numeric-looking string in an ANY column (`'5'`) should be accepted; recommend rejecting (strict storage-class check), as SQLite's dynamic typing is not the model here. Boolean values: reject.

**Streaming rule — `rule-monotonic-window.ts`.** `isRangeSlidingEligible` stays as is (it also declines ANY keys, which keeps ANY on the buffered path where the runtime check lives). Update its doc comment: the non-numeric case is now rejected at build time, so the remaining reason for declining is ANY keys and multi-key specs (the latter now also rejected). Do not loosen it.

## Tests

- `test/plan/window-one-sided-frames.spec.ts` "a non-numeric ORDER BY key keeps every RANGE sliding frame buffered": three of its four bounds now error at prepare. Reduce it to the `between current row and current row` bound (which must still run and stay buffered), and assert the three offset bounds raise. Do not add a separate spec for the error; one case here plus the sqllogic cases is enough.
- `test/logic/07.5-window.sqllogic`: add error cases near the existing RANGE offset block — text key, temporal key (check message mentions interval), ANY key with a text value (runtime error), multi-key, no ORDER BY; and one positive case that `order by <text> range between unbounded preceding and current row` still works. Check the sqllogic error-expectation syntax used elsewhere in that file.
- Run `yarn workspace @quereus/quereus test` and `yarn workspace @quereus/quereus lint`.

## TODO

- Add `validateRangeOffsetFrame` (or similarly named) helper in `select-window.ts` and call it per window group after `orderByExpressions` is built; cover type (numeric / NULL ok, ANY deferred, temporal → interval message, else error) and key count (exactly one).
- Make `rangeOrdinal` in `window.ts` throw for non-null non-numeric values; keep NULL → NaN → peer group; update its doc comment and those of `rangeOffsetStart` / `rangeOffsetEnd`.
- Update the `isRangeSlidingEligible` doc comment in `rule-monotonic-window.ts`.
- Adjust the `window-one-sided-frames.spec.ts` non-numeric case; add sqllogic error + positive cases.
- Update `docs/window-functions.md`: "RANGE vs ROWS" bullet (offsets require exactly one numeric ORDER BY key; temporal keys rejected pending interval offsets; ANY keys checked at runtime), the offset paragraph near line 205, and the rule-ineligibility bullet near line 369.
- Run quereus tests and lint.
