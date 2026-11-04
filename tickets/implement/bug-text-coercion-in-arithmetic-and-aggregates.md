description: Very large whole numbers stored as text lose their last digits when used in arithmetic or added up with sum(), and min()/max() over a text column return a number and can pick a different row than sorting that column would. Make both match how the rest of the engine treats the same text.
prereq: debt-sqllogic-bigint-assertions-lossy
architecture: docs/types.md#physical-representation
files:
  - packages/quereus/src/util/coercion.ts                      # the text-to-number rule; the list of aggregates that opt out of conversion
  - packages/quereus/src/util/numeric-canonical.ts             # optional home for the shared digit-string helper
  - packages/quereus/src/types/builtin-types.ts                # INTEGER_TYPE.parse / NUMERIC_TYPE.parse — the correct sibling path
  - packages/quereus/src/runtime/emit/binary.ts                # buildCoercingArithmeticRun, mixedBigIntArithmetic
  - packages/quereus/src/runtime/emit/unary.ts                 # unary -, + and ~ over text
  - packages/quereus/src/runtime/emit/aggregate-setup.ts       # computeAggregateValueTransforms — doc comment only
  - packages/quereus/src/func/builtins/aggregate.ts            # sumFunc's own text branch
  - packages/quereus/src/core/statement.ts                     # _iterateWithSignal — widen the strict check
  - packages/quereus/test/logic/03.6-type-system.sqllogic      # new arm A cases
  - packages/quereus/test/logic/25-aggregate-edge-cases.sqllogic   # expectation at line 65; new arm B cases
  - packages/quereus/test/logic/14-utilities.sqllogic          # expectation at line 163
  - packages/quereus/test/runtime/aggregate-setup.spec.ts      # lines 113-122 list min/max as converting
  - packages/quereus/test/utility-edge-cases.spec.ts           # lines 274-277 pin min/max as converting
  - docs/types.md
  - docs/runtime.md
  - docs/plugins.md
difficulty: medium
repro: verified
----

# Text-to-number conversion: stop rounding, and leave min/max alone

The maintainer decided on 2026-11-03 to change the results: `min`/`max` over a text column return text in `order by` order, text-to-number conversion in arithmetic and `sum` stops rounding, and `sum` over numeric text keeps working.

**Release notes:** these are deliberate changes in results. There is no changelog file in the repo, so the review and complete tickets must carry a release-note callout covering both changes (see *Release-note text* below).

## The split between the two arms

The two arms sit in the same file but answer different questions, and each gets its own change:

- **What does this text mean as a number?** This is one function, `parseNumericText`, and it returns an exact value (arm A).
- **Which aggregates want a number at all?** This is the existing `NON_NUMERIC_AGGREGATES` list, which gains `MIN` and `MAX` (arm B).

## Reproduction

All values below were observed by running the SQL through a `Database` against the source at `2a24ab6fe`. "After" is a prototype of this design, run in a throwaway copy of the package (since deleted). A trailing `n` marks a JavaScript `bigint`.

### Arm A — text past 2^53 − 1 rounds

| SQL | before | after |
|---|---|---|
| `'9007199254740993' + 0` | 9007199254740992 | 9007199254740993n |
| `0 + '9007199254740993'` | 9007199254740992 | 9007199254740993n |
| `'9007199254740993' + 9007199254740993` | 18014398509481985n | 18014398509481986n |
| `'9007199254740993' - 1` | 9007199254740991 | 9007199254740992n |
| `'9007199254740993' % 10` | 2 | 3 |
| `' 9007199254740993 ' + 0`, `'+9007199254740993' + 0` | 9007199254740992 | 9007199254740993n |
| `'-9007199254740993' + 0` | -9007199254740992 | -9007199254740993n |
| `-'9007199254740993'` | -9007199254740992 | -9007199254740993n |
| `+'9007199254740993'` | 9007199254740992 | 9007199254740993n |
| `~'9007199254740993'` | -9007199254740993n | -9007199254740994n |
| `sum(v)` over rows `'9007199254740993'`, `'1'` | 9007199254740992 | 9007199254740994n |

These must not change: `'123' + 0` → 123, `'abc' + 0` → 0, `'' + 0` → 0, `'1e400' + 0` → null, `'1e20' + 0` → the double 1e20, `'9007199254740993.0' + 0` → the double 9007199254740992, `'9007199254740993' + 0.5` → a double, `'9007199254740993' / 0` → null.

Unary operators and the text branch inside `sum` were not named in the original ticket. They have the same defect and are in scope, because the decision covers "text-to-number conversion in arithmetic and `sum`".

### Arm B — min/max convert text

With `create table t (id integer primary key, v text); insert into t values (1, '5'), (2, '10');`:

| SQL | before | after |
|---|---|---|
| `select min(v), max(v) from t` | 5, 10 (numbers) | '10', '5' |
| `select min(v), max(v) from t group by 1=1` | 5, 10 | '10', '5' |
| `select min(distinct v) from t` | 5 | '10' |
| `select typeof(min(v)) from t` | 'integer' | 'text' |
| `select sum(v), avg(v) from t` | 15, 7.5 | 15, 7.5 (unchanged) |

Over an ANY column holding `'5'`, `'10'`, `7`: before, `min(v), max(v)` returned 5, 10. After, they return 7, '5', which matches `order by v` and `order by v desc`.

Two paths already behave correctly and show the target: `min(v) over ()` returns '10', and `order by v limit 1` returns '10'. Materialized-view maintenance also calls `stepFunction` directly (`core/database-materialized-views-apply.ts:888`) with no conversion, so this change removes a disagreement there too.

## Design

### `parseNumericText` (coercion.ts)

```ts
export function parseNumericText(text: string): number | bigint {
	const trimmed = text.trim();
	const approx = Number(trimmed);
	// NaN and everything inside the safe range: Number() was already exact or is float by nature.
	if (!(Math.abs(approx) > Number.MAX_SAFE_INTEGER)) return approx;
	return /^[+-]?\d+$/.test(trimmed) ? <exact bigint from the digits> : approx;
}
```

- It returns NaN for non-numeric text, and each caller maps that to its own rule: arithmetic → 0, unary → null, `tryCoerceToNumber` → the original string, `sum` → skip.
- A digit string whose `Number()` lands inside the safe range is exact, so the small-value path runs one extra comparison and no regex. Only text operands take this path; the numeric-typed fast path in `binary.ts` never reaches it. This was not benchmarked.
- A digit string too long for a double makes `Number()` return Infinity. The guard above still sends it to the bigint arm, which agrees with `cast(... as integer)`. The prototype did not run this case, so confirm it in the implementation.
- Non-digit forms keep `Number()`'s meaning. Hex past 2^53 (`'0x20000000000001' + 0`) still rounds; leave it, with a `NOTE:` at the regex. `cast` reads that text as 0 anyway, so there is no exact sibling for it to agree with.
- The sign-stripping digit-to-bigint step already exists twice in `builtin-types.ts` (`INTEGER_TYPE.parse`, `NUMERIC_TYPE.parse`). Move it to one helper in `util/numeric-canonical.ts` and use it from all three places.

`tryCoerceToNumber` calls `parseNumericText` and keeps its existing rejection of NaN and non-finite values. A bigint result passes through.

`coerceToNumberForArithmetic` returns `number | bigint`. It must pass a `bigint` input through unchanged: today that input falls to the final `else` and becomes 0, which only its callers' guards hide.

### Arithmetic (binary.ts)

- `buildCoercingArithmeticRun`: coerce both operands first, then route to `mixedBigIntArithmetic` if either result is a `bigint`. The current check looks at the uncoerced values, so text never reaches the bigint path.
- `mixedBigIntArithmetic`: coerce first, then test "both bigint". The existing `num` logic assumes exactly one side is bigint, so two text operands past the safe range would break it if the order stayed as it is.
- The numeric-typed fast path (`runNumericOnly`) is unchanged.

The announced result type needs no change: a TEXT operand already announces ANY (`planner/nodes/scalar.ts`), which admits a bigint.

Safe-range text whose *result* escapes the safe range (`'9007199254740991' * 3`) stays on the number path and is still inexact. That defect belongs to `bug-integer-arithmetic-silently-leaves-the-exact-integer-range`, not this ticket.

### Unary (unary.ts)

The generic arms of `-`, `+` and `~` use `Number(operand)`. Add one small helper in `coercion.ts` that applies `parseNumericText` to strings and `Number()` to everything else, then handle the bigint result in each arm. Keep the existing null-on-NaN behaviour.

### sum (aggregate.ts)

Replace `Number(value)` in `sumFunc`'s string branch with `parseNumericText`. The aggregate emitters convert before the step, but materialized-view maintenance does not, so this branch is reachable. `avg`, `total` and the statistical aggregates compute in floating point by design and stay as they are. They already accept a bigint argument through `Number(value)`.

### min/max (coercion.ts)

Add `'MIN', 'MAX'` to `NON_NUMERIC_AGGREGATES`. `computeAggregateValueTransforms` then returns `undefined` for them, so no value is converted before the comparator runs.

Leave the semantic-ordering skip in `computeAggregateValueTransforms` as it is. Its comment says the arm exists for a type-aware comparator; min/max no longer need it, so reword that comment rather than remove the behaviour. The arm still decides what `sum`/`avg` see over TIMESPAN and JSON arguments.

### Widening the strict check (statement.ts)

`Statement._iterateWithSignal` checks only R1 (`docs/types.md`) because min/max over text was the last suite failure. Pass the result columns' logical types instead of `NO_DECLARED_TYPES`, resolved once outside the row loop rather than per row, and delete the constant.

The prototype ran with this widening under `QUEREUS_REPR_STRICT=1`, and the only `.sqllogic` failures were the two expected-value changes listed below. Those are plain value mismatches, and each stops its own file at the first failure, so **rerun `test:repr-strict` after updating them** to cover the rest of those two files.

Keep the part of the seam comment about `9007199254740991 * 3`: that backlog ticket is still open and no suite site trips it.

## Expected test changes

The whole-package Mocha run on the prototype (with strict mode and the widening on, without `--bail`) gave 11013 passing and 10 failing. Six failures came from the partial copy (no `docs/`, no sample plugins). The other four are the real changes:

- `test/logic/14-utilities.sqllogic:163` — `min(amount)` becomes `"10"`. Rewrite the comment above it, which describes the old conversion.
- `test/logic/25-aggregate-edge-cases.sqllogic:65` — `mn` becomes `"10"`. Rewrite the comment above it too.
- `test/runtime/aggregate-setup.spec.ts:113-122` — move `min`, `max` from the "routes every other aggregate" list to the non-numeric list.
- `test/utility-edge-cases.spec.ts:274-277` — `coerceForAggregate('42', 'MIN')` and `'MAX'` now return `'42'`.

`test:store` was not run on the prototype.

## New tests

Add reproductions only, in `.sqllogic`. The harness now compares large whole numbers exactly, so these fail on the rounded answers.

- `03.6-type-system.sqllogic`: the before/after rows of arm A's table, plus one row showing a fractional-form text staying a double.
- `25-aggregate-edge-cases.sqllogic`: write the arm B invariant against `order by` rather than as fixed values alone, for example `select (select min(v) from t) = (select v from t order by v limit 1)`, along with `typeof(min(v))`. Cover the ungrouped path and a `group by` path, and an ANY column with mixed text and numbers.

## Docs and comments to update

- `docs/types.md` — the egress row of the seam table and the "still asserts R1 only" paragraph (about lines 200-222).
- `docs/runtime.md` — "Arithmetic Context" and "Aggregate Context" (about lines 1132-1146): min/max do not convert, and arithmetic stays exact past the safe range.
- `docs/plugins.md:1353` — the return type of `coerceToNumberForArithmetic` changes on a public export. Plugin aggregates can now receive a `bigint` from text past the safe range.
- `util/coercion.ts` — delete the `NOTE:` above `coerceToNumberForArithmetic` and the one above `coerceAggregateValue` (it cites the retired slug `bug-text-minmax-numeric-coercion`). The doc comment on `tryCoerceToNumber` should state the exact result. Both issues are resolved here, so nothing needs repointing.
- `core/statement.ts` — the seam comment.
- Grep `docs/` for other claims that min/max convert numeric text.

## Release-note text

Carry this forward to the review and complete tickets:

> `min()` and `max()` over text now compare as text and return text, matching `order by` (`min` over `'5'`, `'10'` returns `'10'`; it used to return the number 5). Convert explicitly to get numeric order: `min(cast(v as integer))`. Arithmetic and `sum()` over text holding a whole number past 9,007,199,254,740,991 now return the exact value instead of a rounded one; the result can be a JavaScript `bigint`. `coerceToNumberForArithmetic` now returns `number | bigint`.

## Out of scope

- Window `sum(v) over ()` over large text still rounds. It rounds large integer columns too, and `bug-window-sum-loses-exactness-vs-grouped-sum` owns that; the text case has been added there.
- `avg` exactness also belongs to that ticket (its arm 2).

## TODO

- Add `parseNumericText` and the shared digit-string helper; use the helper in `INTEGER_TYPE.parse` and `NUMERIC_TYPE.parse`
- Rework `tryCoerceToNumber` and `coerceToNumberForArithmetic` on top of it, including the bigint pass-through
- Reorder coercion in `buildCoercingArithmeticRun` and `mixedBigIntArithmetic`
- Fix the unary `-`, `+` and `~` generic arms
- Use `parseNumericText` in `sumFunc`'s string branch
- Add `MIN` and `MAX` to `NON_NUMERIC_AGGREGATES`; reword the `computeAggregateValueTransforms` comment
- Widen the check in `Statement._iterateWithSignal` and delete `NO_DECLARED_TYPES`
- Update the four expected-result sites and add the new `.sqllogic` cases
- Update docs and comments as listed
- Run `yarn workspace @quereus/quereus run lint`, `yarn test`, `yarn workspace @quereus/quereus run test:repr-strict` and `yarn workspace @quereus/quereus run test:store` (min/max results also flow through the store path)
- Include the release-note text in the review handoff
