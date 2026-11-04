description: The built-in number-series table function now produces exactly the whole numbers between its two bounds, instead of fractions, wrong or endlessly repeated values past 2^53, and a series that read a missing bound as zero.
architecture: docs/types.md#physical-representation
files:
  - packages/quereus/src/func/builtins/generation.ts       # seriesBound, seriesRange, nextSeriesInteger, generator, estimatedRows
  - packages/quereus/test/logic/03.5-tvf.sqllogic          # generate_series cases at the end
  - docs/functions.md                                      # generate_series entry
  - docs/sql-functions.md                                  # removed a step argument that does not exist
  - docs/optimizer-retrieve.md                             # parameter name in the advertisement table
repro: verified
----

`generate_series(start, stop)` declares one non-null INTEGER column `value`, advertised as a strictly ascending key. It used to convert both bounds with `Number(...)` and count in floating point, which made that declaration false. The series is now exactly the integers `n` with `start <= n <= stop`, ascending.

## What was built

Each bound goes through `NUMERIC_TYPE.parse`, rounds inward (`Math.ceil` for start, `Math.floor` for stop), then goes through `canonicalizeInteger`. A NULL, infinite or NaN bound gives no rows. The counter is a `number` inside the safe-integer range and a `bigint` outside it, so every value follows rule R1 in `docs/types.md` and the counter always advances. `estimatedRows` uses the same conversion, which replaced its four mixed-type branches with one.

Behaviour changes for callers: `generate_series('abc', 4)` and a blob bound now raise a conversion error instead of returning rows or nothing, and `generate_series('2abc', 3)` now gives `2, 3`, because `NUMERIC_TYPE.parse` reads a leading number. `docs/functions.md` documents these.

## Review findings

Read the diff in `ticket(implement): bug-generate-series-yields-non-integers` before the handoff.

**Fixed in this pass**

- Tests: the two infinite-bound cases had no `limit`, so a regression would have exhausted memory and killed the run instead of failing. Both now carry `limit 3`.
- Tests: cut three cases that pinned no extra behaviour. `(1, 3.5)` is covered by `(-2.5, -0.5)`, which also distinguishes floor from truncation. `(1, null)` takes the same path as `(-2, null)`. The `series_seek` query, which the implement ticket asked for, used a memory table with no seek-value check, so it could only fail where `(0.5, 3)` already does; the lamina check that originally raised the error is not in this repository.
- Docs: `docs/optimizer-retrieve.md` still named the second parameter `end`; now `stop`, matching the code and other docs.

**Checked, no change needed** (run through a throwaway script against the source, except where noted)

- Safe-integer boundary, both directions: `(9007199254740991, 9007199254740992)` gives `number` then `bigint`; `(-9007199254740992, -9007199254740991)` gives `bigint` then `number`. Both are R1-canonical.
- Whole `number` past the safe range: parameter `1e20` becomes the exact `bigint`, and `-0` as a parameter yields `0`.
- Non-literal bounds: a correlated `(select count(*) from generate_series(t.a, t.b))` over an `any` column handled integer, text, fractional and NULL stops correctly. Parameter stops such as `3.5` also work.
- Other bound types: boolean reads as 0 or 1, text is trimmed and accepts `+`, text `'Infinity'` gives no rows, text `'NaN'` and an object raise the conversion error. These match `docs/functions.md`.
- Empty and extreme ranges: `(5, 1)`, `(1.5, 1.7)` and `(1e300, 1)` give no rows. `(-1.7e308, 1.7e308) limit 2` returns promptly.
- Consumers of the mixed `number`/`bigint` column: `order by value desc`, a join to an integer primary key holding values past 2^53, and a join of two series all returned the correct rows.
- `estimatedRows`: read the code only; not re-run. Its implement-stage throwaway results are consistent with the code. `resolveAdvertisement` catches the throw from text like `'abc'`, and `TableFunctionCallNode` drops a non-finite estimate, so `(-1.7e308, 1.7e308)` overflowing to `Infinity` is harmless.
- Other `generate_series` references under `docs/`, `README.md` and `packages/`: none describe the old behaviour or a step argument.

**Noticed and left alone**

- Both bounds are always converted, so `(null, 'abc')` raises an error rather than giving no rows. This is deterministic and agrees with the rule that non-numeric text is an error, so no change and no tripwire.
- `NUMERIC_TYPE.parse` falling back to `parseFloat` makes a date string read as its year: `'2020-01-01'` reads as 2020. That leniency belongs to the shared conversion, which the ticket chose deliberately, and `docs/functions.md` states the leading-number rule. No ticket filed, since no anchor asks for stricter NUMERIC text parsing.
- A literal empty range estimates `undefined`, which falls back to 10 rows, rather than 0. The implement ticket specified this and a literal series is constant-folded anyway.

**Major findings:** none. **Tripwires added:** none, because nothing found was conditional on a later change.

**Already tracked elsewhere**

- Output of table-valued functions is not checked under `QUEREUS_REPR_STRICT`, and the logic tests compare past-2^53 values as text, so neither would catch a non-canonical `bigint` inside the safe range: `implement/tvf-output-representation-check`.
- A huge finite literal stop such as `(1, 1e300)` still buffers until memory runs out: `backlog/bug-constant-folded-relation-buffers-every-row`.

## Validation

After the review edits:

- `yarn workspace @quereus/quereus test`: 10985 passing, 25 pending.
- `yarn workspace @quereus/quereus lint`: exit 0.
- `yarn workspace @quereus/quereus test:repr-strict`: 10994 passing, 16 pending. The implement stage had not run this.
- Not re-run: root `yarn test`, which passed at the implement stage. No source file changed in review, only one logic test file and one doc.
- Not run: `yarn test:store`.
