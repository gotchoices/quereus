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
  - docs/types.md
  - docs/runtime.md
  - docs/plugins.md
  - docs/functions.md
difficulty: medium
repro: verified
----

# Text-to-number conversion: stop rounding, and leave min/max alone

The maintainer decided on 2026-11-03 to change the results. There are two separate changes:

- **What does this text mean as a number?** One function, `parseNumericText` in `util/coercion.ts`, now answers this. A whole-number digit string past 2^53 − 1 becomes an exact `bigint`. Everything else keeps `Number()`'s reading.
- **Which aggregates want a number at all?** `MIN` and `MAX` joined the `NON_NUMERIC_AGGREGATES` list, so no conversion runs before their comparator.

`Statement._iterateWithSignal` now also checks each result row against the column's announced type under `QUEREUS_REPR_STRICT`, not just the canonical-number rule.

## Release-note text

There is no changelog file in the repo, so this text is kept here for the release notes. The review added the division sentence and the sentence about `tryCoerceToNumber` and plugin aggregates.

> `min()` and `max()` over text now compare as text and return text, matching `order by` (`min` over `'5'`, `'10'` returns `'10'`; it used to return the number 5). Convert explicitly to get numeric order: `min(cast(v as integer))`. Arithmetic and `sum()` over text holding a whole number past 9,007,199,254,740,991 now return the exact value instead of a rounded one; the result can be a JavaScript `bigint`. Such text now also divides like a large integer, truncating with a whole-number divisor: `'9007199254740993' / 1000000000000000` returns 9, where it used to return 9.007199254740992. `coerceToNumberForArithmetic` now returns `number | bigint`, `tryCoerceToNumber` can return a `bigint`, and a plugin aggregate can receive a `bigint` argument from such text.

## Behaviour after this change

A trailing `n` marks a JavaScript `bigint`.

| SQL | before | after |
|---|---|---|
| `'9007199254740993' + 0` and `0 + '9007199254740993'` | 9007199254740992 | 9007199254740993n |
| `'9007199254740993' + '9007199254740993'` | 18014398509481984 | 18014398509481986n |
| `'9007199254740993' % 10` | 2 | 3 |
| `'9007199254740993' / 1000000000000000` | 9.007199254740992 (worked out from the old conversion, not run) | 9 |
| `-'9007199254740993'`, `+'...'`, `~'...'` | rounded | exact |
| `sum(v)` over `'9007199254740993'`, `'1'` | 9007199254740992 | 9007199254740994n |
| `min(v), max(v)` over TEXT `'5'`, `'10'` | 5, 10 (numbers) | `'10'`, `'5'` |
| `min(v), max(v)` over ANY `'5'`, `'10'`, `7` | 5, 10 | 7, `'5'` |

These do not change: `'123' + 0` is 123, `'abc' + 0` is 0, `'' + 0` is 0, `'1e400' + 0` is null, `'1e20' + 0` is the double 1e20, `'9007199254740993.0' + 0` is the double 9007199254740992, `'9007199254740993' + 0.5` is a double, `'9007199254740993' / 0` is null, and `sum`/`avg` over `'5'`, `'10'` are 15 and 7.5.

## Review findings

**Validation, after the review's edits**

- `yarn workspace @quereus/quereus run lint`: no errors.
- `yarn test`: no failures in any workspace (`packages/quereus` 11013 passing, 26 pending).
- `yarn workspace @quereus/quereus run test:repr-strict`: 11023 passing, 16 pending, with the widened statement-row check on.
- `yarn workspace @quereus/quereus run test:store` was not re-run after the review's edits. The implement stage ran it clean at 11006 passing, 33 pending. The review's code edits are the small refactors listed below, and none touches storage.

**Do the new tests detect the bugs? (a gap the implementer left open)** Yes. With each fix temporarily disabled in the working tree and then restored:

- With `parseNumericText` returning the rounded double, `03.6-type-system.sqllogic` fails on its first new row (actual 9007199254740992, expected 9007199254740993).
- With `MIN` and `MAX` removed from the list, `14-utilities.sqllogic` and `25-aggregate-edge-cases.sqllogic` fail on `min(...)` returning the number 10. The harness stops a file at its first failure, so the later new min/max rows in file 25 were not individually exercised this way.

**Found and fixed in this pass**

- Behaviour change missing from the ticket and the docs: past-safe-range text now takes the truncating `bigint` division path, so `'9007199254740993' / 1000000000000000` returns 9 rather than about 9.007. This matches the integer literal and the documented `/` rule in `docs/types-inference.md`, so the code stays as it is. I added it to the release note and `docs/runtime.md`, and pinned it with one row in `03.6-type-system.sqllogic`.
- Release note was incomplete for plugin authors: `tryCoerceToNumber` and plugin aggregates can now see a `bigint`. Added.
- `mixedBigIntArithmetic` coerced operands that `buildCoercingArithmeticRun` had already coerced (the implementer's listed gap). It now takes `number | bigint`, and `runNumericOnly` coerces at its call site.
- `coerceAggregateValue` repeated the guard that `tryCoerceToNumber` already applies, adding a redundant trim per row. It now just calls `tryCoerceToNumber`.
- The "where values are born" list in the `numeric-canonical.ts` header omitted text read as a number. Added.
- A comment in `06.5.3-undeclared-return-type-comparison.sqllogic` named `computeAggregateSkipCoercion`, which no longer exists. It now names `computeAggregateValueTransforms`. This one predates the ticket.

**Checked by running SQL against the source, no defect found**

- Boundary: `'9007199254740991' + 0` stays a number, and `'9007199254740992' + 0` is a `bigint`, as the canonical rule requires.
- Operand mixes: `true` and a blob with big text, null with big text, `'...' % 0`, `'...' * 1.5` (double), and `'...' + 1e300` (same `bigint` as the integer literal). `'...' + 1.0` gives the `bigint` 9007199254740994n.
- Unary operators over `'Infinity'`, `'abc'`, `''`, a blob, `true` and `'P1D'` keep their previous conversions. `-'Infinity'` returns -Infinity, which the replaced `Number()` code also produced.
- `avg`, `total`, `var_pop`, `stddev_samp` and `sum(distinct)` accept a `bigint` argument. All but `sum(distinct)` read it through `Number()`; `avg` exactness is owned by the ticket named below.
- Window `min`/`max` never coerced (read in `runtime/emit/window.ts`), and they returned the same text as the aggregate form in the probe. `order by` agreed as well.
- `min('5','10')` raises "Function not found", so there is no two-argument `min`/`max` to bring into line.

**Checked by reading, no defect found**

- Internal `min` uses in the group-by simplification rule and mutation planning go through the same aggregate, so they now keep text values rather than converting them.
- Generic text arithmetic and unary `-`/`+` announce `ANY`, which imposes no representation constraint, and `~` announces INTEGER, which admits a `bigint`. The repr-strict run confirms no conflict in the suite, and the probe ran clean with the flag on.
- Callers of the changed exports: inside the engine only `aggregate-setup.ts` and `binary.ts` use them, and no other package does.
- Docs: the changed sections of `types.md`, `runtime.md`, `plugins.md` and `functions.md`, the arithmetic table in `types-inference.md`, and a search of source, tests and docs for stale references to this ticket and the old min/max note. None remain. Two backlog tickets mention this ticket as history.

**Major findings: none.** No ticket filed.

**Tests:** the implementer's new and changed tests each pin a behaviour from the table, so none were cut. One row was added, for division.

**Tripwires:** no new ones. The existing hex `NOTE:` at `parseNumericText` and the safe-integer overflow `NOTE:` in `binary.ts` and `statement.ts` still describe the code accurately.

**Remaining gaps**

- The sqllogic harness does not tell a `bigint` from a double holding the same value. `'9007199254740993' - 1` still pins exactness, because the lossy reading gives a different number. The `bigint` form itself was confirmed by the direct probe, not by a suite row.
- The small-value path gains one comparison for text operands and no regex. This was not benchmarked.

## Out of scope, owned elsewhere

- Safe-range text whose result escapes the safe range (`'9007199254740991' * 3`) is still inexact: `bug-integer-arithmetic-silently-leaves-the-exact-integer-range`. That ticket can now trip the widened strict check, and the seam comment in `statement.ts` says so.
- Window `sum(v) over ()` over large text and `avg` exactness: `bug-window-sum-loses-exactness-vs-grouped-sum`.
