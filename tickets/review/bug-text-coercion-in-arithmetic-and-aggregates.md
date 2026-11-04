description: Very large whole numbers stored as text no longer lose their last digits in arithmetic or sum(), and min()/max() over a text column now return text and pick the same row that sorting that column would.
prereq: debt-sqllogic-bigint-assertions-lossy
architecture: docs/types.md#physical-representation
files:
  - packages/quereus/src/util/coercion.ts                      # parseNumericText, coerceUnaryOperand, NON_NUMERIC_AGGREGATES gains MIN and MAX
  - packages/quereus/src/util/numeric-canonical.ts             # integerFromDigits, the shared digit-string helper
  - packages/quereus/src/types/builtin-types.ts                # INTEGER_TYPE.parse and NUMERIC_TYPE.parse now use the helper
  - packages/quereus/src/runtime/emit/binary.ts                # buildCoercingArithmeticRun, mixedBigIntArithmetic
  - packages/quereus/src/runtime/emit/unary.ts                 # generic arms of -, + and ~
  - packages/quereus/src/runtime/emit/aggregate-setup.ts       # computeAggregateValueTransforms doc comment only
  - packages/quereus/src/func/builtins/aggregate.ts            # sumFunc's text branch
  - packages/quereus/src/core/statement.ts                     # _iterateWithSignal checks announced types; NO_DECLARED_TYPES deleted
  - packages/quereus/test/logic/03.6-type-system.sqllogic
  - packages/quereus/test/logic/25-aggregate-edge-cases.sqllogic
  - packages/quereus/test/logic/14-utilities.sqllogic
  - packages/quereus/test/runtime/aggregate-setup.spec.ts
  - packages/quereus/test/utility-edge-cases.spec.ts
  - packages/quereus/test/announced-result-types.spec.ts       # comment only
  - docs/types.md
  - docs/runtime.md
  - docs/plugins.md
  - docs/functions.md
difficulty: medium
repro: verified
----

# Text-to-number conversion: stop rounding, and leave min/max alone

The maintainer decided on 2026-11-03 to change the results. There are two changes, and they are deliberately separate:

- **What does this text mean as a number?** One function, `parseNumericText` in `util/coercion.ts`, now answers this. A whole-number digit string past 2^53 − 1 becomes an exact `bigint`. Everything else keeps `Number()`'s reading.
- **Which aggregates want a number at all?** `MIN` and `MAX` joined the `NON_NUMERIC_AGGREGATES` list, so no conversion runs before their comparator.

## Release-note text

There is no changelog file in the repo, so this must be carried to the complete ticket:

> `min()` and `max()` over text now compare as text and return text, matching `order by` (`min` over `'5'`, `'10'` returns `'10'`; it used to return the number 5). Convert explicitly to get numeric order: `min(cast(v as integer))`. Arithmetic and `sum()` over text holding a whole number past 9,007,199,254,740,991 now return the exact value instead of a rounded one; the result can be a JavaScript `bigint`. `coerceToNumberForArithmetic` now returns `number | bigint`.

## Behaviour to check

A trailing `n` marks a JavaScript `bigint`.

| SQL | before | after |
|---|---|---|
| `'9007199254740993' + 0` and `0 + '9007199254740993'` | 9007199254740992 | 9007199254740993n |
| `'9007199254740993' + '9007199254740993'` | 18014398509481984 | 18014398509481986n |
| `'9007199254740993' % 10` | 2 | 3 |
| `-'9007199254740993'`, `+'...'`, `~'...'` | rounded | exact |
| `sum(v)` over `'9007199254740993'`, `'1'` | 9007199254740992 | 9007199254740994n |
| `min(v), max(v)` over TEXT `'5'`, `'10'` | 5, 10 (numbers) | `'10'`, `'5'` |
| `min(v), max(v)` over ANY `'5'`, `'10'`, `7` | 5, 10 | 7, `'5'` |

These do not change: `'123' + 0` is 123, `'abc' + 0` is 0, `'' + 0` is 0, `'1e400' + 0` is null, `'1e20' + 0` is the double 1e20, `'9007199254740993.0' + 0` is the double 9007199254740992, `'9007199254740993' + 0.5` is a double, `'9007199254740993' / 0` is null, and `sum`/`avg` over `'5'`, `'10'` are 15 and 7.5.

The ticket left one case unconfirmed: a digit string too long for a double. It now has a test. A 313-digit string, for which `Number()` returns Infinity, adds to 0 and equals `cast(... as integer)`.

`Statement._iterateWithSignal` now checks each result row against the column's announced type under `QUEREUS_REPR_STRICT`, not just the canonical-number rule.

## Tests

New `.sqllogic` reproductions:

- `03.6-type-system.sqllogic`: each arm A row above (both operand orders, two text operands, surrounding spaces, `+` and `-` signs, the unary operators, `sum`), the 313-digit string agreeing with `cast`, and the unchanged cases as controls.
- `25-aggregate-edge-cases.sqllogic`: min/max over TEXT return text with `typeof` 'text', agree with `order by` written as an invariant, on the ungrouped, `group by` and `distinct` paths, over an ANY column with mixed values, and `sum`/`avg` still read the same column as numbers.

Updated expectations, all listed in the ticket: `14-utilities.sqllogic` (`min(amount)` is `"10"`), `25-aggregate-edge-cases.sqllogic` (`mn` is `"10"`), `aggregate-setup.spec.ts` (min/max moved to the non-converting list), `utility-edge-cases.spec.ts` (`coerceForAggregate('42', 'MIN')` returns `'42'`).

## Validation run

- `yarn workspace @quereus/quereus run lint`: clean. `tsc -p packages/quereus/tsconfig.json --noEmit`: clean.
- `yarn test`: no failures in any workspace (`packages/quereus` 11013 passing, 26 pending).
- `yarn workspace @quereus/quereus run test:repr-strict`: 11023 passing, 16 pending, with the widened check on. The ticket warned that the two changed expectations hid the rest of those files on the prototype; this run covers them.
- `yarn workspace @quereus/quereus run test:store`: 11006 passing, 33 pending.

The test commands above ran before the final doc-only edit to `docs/functions.md`.

## Known gaps

- I did not run the new cases against the old source. They rest on the "before" values measured in the ticket, which differ from the expected values, except for the unchanged-case controls. A reviewer can confirm this with a scratch checkout.
- The sqllogic harness does not tell a `bigint` from a double holding the same value, so `'9007199254740993' - 1` (expected 9007199254740992) pins the value but not the `bigint` form. Other rows and the strict check cover the form.
- Hex text past 2^53 (`'0x20000000000001' + 0`) still rounds, by design. A `NOTE:` at the regex in `parseNumericText` records why.
- `buildCoercingArithmeticRun` coerces both operands and `mixedBigIntArithmetic` coerces them again. The second pass does nothing, and only happens on the bigint path. `mixedBigIntArithmetic` has to keep coercing because `runNumericOnly` calls it with raw values.
- The small-value path gains one comparison for text operands and no regex. This was not benchmarked.
- `parseNumericText`, `coerceUnaryOperand` and `integerFromDigits` are not exported from `index.ts`, because nothing outside the package needs them.

## Out of scope, owned elsewhere

- Safe-range text whose result escapes the safe range (`'9007199254740991' * 3`) is still inexact: `bug-integer-arithmetic-silently-leaves-the-exact-integer-range`. That ticket can now trip the widened strict check, and the seam comment in `statement.ts` says so. No suite site does today.
- Window `sum(v) over ()` over large text and `avg` exactness: `bug-window-sum-loses-exactness-vs-grouped-sum`.
