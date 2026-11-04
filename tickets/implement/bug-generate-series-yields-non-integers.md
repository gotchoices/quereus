description: The built-in number-series table function promises whole numbers, but a fractional start produces fractions, very large bounds produce wrong or endlessly repeated values, and a missing bound is read as zero. Make it produce exactly the whole numbers between its two bounds.
architecture: docs/types.md#physical-representation
files:
  - packages/quereus/src/func/builtins/generation.ts       # generateSeriesFunc: the generator body and estimatedRows, the only code change
  - packages/quereus/src/util/numeric-canonical.ts         # canonicalizeInteger, reused
  - packages/quereus/src/types/builtin-types.ts            # NUMERIC_TYPE.parse, reused as the bound conversion
  - packages/quereus/test/logic/03.5-tvf.sqllogic          # reproduction tests go here
  - packages/quereus/test/logic/03.7-bigint-mixed-arithmetic.sqllogic  # how expected bigint results are written
  - packages/quereus/test/planner/tvf-physical-properties.spec.ts      # existing estimatedRows coverage, must stay green
  - docs/functions.md                                      # ~:714 generate_series entry
  - docs/sql-functions.md                                  # ~:354 lists a step argument that does not exist
repro: verified
----

`generate_series(start, stop)` declares one non-null column `value` of type INTEGER, and advertises it as a strictly ascending key. The generator converts both bounds with `Number(...)` and counts in floating point, so that declaration is false for several inputs.

## Reproduction

Run against the built engine (`db.eval`, `Number`/`bigint` shown as returned). The first group breaks the declared type; the rest are wrong answers from the same line of code.

| query | today | cause |
|---|---|---|
| `generate_series(0.5, 3)` | `0.5, 1.5, 2.5` | start is not an integer |
| `generate_series(-2.5, 0)` | `-2.5, -1.5, -0.5` | same |
| `generate_series(-9007199254740993, -9007199254740990)` | `-9007199254740992, -9007199254740991, -9007199254740990` (three rows, first one a wrong unsafe `number`) | `Number(bigint)` rounds the bound |
| `generate_series(?, ?)` with `9007199254740990`, `9007199254740992n` | `...990, ...991, ...992, ...992, ...992, ...` forever | `++i` stops changing `i` at 2^53 |
| same call written with literals | process dies: "JavaScript heap out of memory" | the endless series above, buffered by constant folding |
| `generate_series(1, 1e400)` | process dies the same way (`limit 2` returns `1, 2`) | infinite stop |
| `generate_series(null, 3)` | `0, 1, 2, 3` | `Number(null)` is 0 |
| `generate_series(-2, null)` | `-2, -1, 0` | same |
| `generate_series('', 1)` | `0, 1` | `Number('')` is 0 |

`generate_series(1, 3.5)` already gives `1, 2, 3`, and `generate_series(1, null)` already gives no rows; both must stay that way.

Downstream effect, from the original lamina report: `select g.value, (select count(*) from ip p where p.pid < g.value) from generate_series(0.5, 3) g` raises "seek value for column 'pid' (int) is a non-integer number, which contradicts its declared SQL type" under lamina, and a module that did not check would seek a truncated key.

## Decision

**The series is exactly the integers `n` with `start <= n <= stop`, ascending.** A fractional start rounds up, a fractional stop rounds down.

| input | result |
|---|---|
| `generate_series(0.5, 3)` | `1, 2, 3` |
| `generate_series(-2.5, -0.5)` | `-2, -1` |
| `generate_series(1, 3.5)` | `1, 2, 3` (unchanged) |
| a NULL bound on either side | no rows (`-2, null` and `null, 3` change, `1, null` does not) |
| an infinite or NaN bound | no rows, matching `cast(1e400 as integer)`, which gives NULL |
| numeric text (`'2'`, `'9007199254740993'`, `'2.5'`) | read as that number, exactly past 2^53 |
| `''` | NULL, so no rows |
| non-numeric text, a blob | error from the conversion, `Cannot convert 'abc' to NUMERIC`, wrapped as `Table-valued function generate_series failed: ...` |

Alternatives rejected:

- **Truncate as `cast(x as integer)` does.** It yields values outside the requested range: `generate_series(0.5, 3)` would include `0`, and a stop of `-0.5` would include `0`, which changes a result that is correct today.
- **Reject fractional bounds.** A fractional stop produces correct integers today, so this would break working calls such as `generate_series(1, x / 2)`, and would fail a correlated query partway through on the first fractional row.
- **Declare the column REAL or ANY.** The type is fixed at plan time and cannot follow runtime bounds, and it would remove the integer key that lamina and the optimizer rely on.

Behaviour changes to expect: `generate_series('abc', 4)` goes from no rows to an error, and `generate_series(1, 1e400) limit 2` goes from `1, 2` to no rows. A search of every `generate_series` call under `packages/` found that all of them start at the literal `1`, with a stop that is a small integer literal, a parameter, a column or a subquery. A fractional or NULL stop gives the same rows after this change as before, so only a non-numeric text stop or an infinite stop could change an existing result; the column and parameter values were not individually checked, so the test run is what confirms it.

## Shape of the change

One helper converts a bound, the generator and `estimatedRows` both use it, and the four mixed-type arms of `estimatedRows` collapse into one. Sketch:

```ts
// null means "no integer reading": the series is empty.
function seriesBound(value: SqlValue, round: (n: number) => number): number | bigint | null {
	const parsed = NUMERIC_TYPE.parse(value) as number | bigint | null;
	if (parsed === null || typeof parsed === 'bigint') return parsed;
	if (!Number.isFinite(parsed)) return null;
	return canonicalizeInteger(round(parsed) + 0); // + 0 turns the -0 from Math.ceil(-0.5) into 0
}
```

Iterate with a `number` inside the safe range and a `bigint` outside it, so each yielded value is canonical and the counter always advances. Something like `typeof i === 'number' && i < Number.MAX_SAFE_INTEGER ? i + 1 : canonicalizeInteger(BigInt(i) + 1n)`, which also narrows back to `number` when a negative series climbs into the safe range. JavaScript's `<=` compares `number` with `bigint` exactly.

`estimatedRows` becomes `Number(BigInt(hi) - BigInt(lo)) + 1` over the two converted bounds, keeping `undefined` for a non-literal operand, a NULL bound or `hi < lo`. Today a fractional literal start gives a fractional estimate (`generate_series(0.5, 3)` estimates 3.5). `resolveAdvertisement` already catches a throw from this closure, so a non-numeric text literal stays "no estimate".

## Out of scope

- A `step` argument. `numArgs` is 2 and nothing asks for one; the docs are corrected instead.
- Buffering of a very long constant series: `backlog/bug-constant-folded-relation-buffers-every-row`. After this ticket a literal series always terminates, but a long one is still held in memory.
- Checking table-valued function output under `QUEREUS_REPR_STRICT`: `implement/tvf-output-representation-check`, which depends on this ticket.

## TODO

- Add reproduction cases to `packages/quereus/test/logic/03.5-tvf.sqllogic`, and see them fail first: fractional start (positive and negative), fractional stop, NULL on each side, an infinite bound, numeric text, non-numeric text as an error, a series crossing 2^53 upward, one starting below -2^53, and the correlated `p.pid < g.value` query against a memory table (expected `[1,0], [2,1], [3,2]`). Write the 2^53 cases with a `limit` a little above the expected row count, so a regression returns repeated values and fails instead of hanging; an unbounded literal with `limit 2` returned promptly in the reproduction.
- Rewrite the generator and `estimatedRows` in `generation.ts` as described, removing the now-unneeded `Number(...)` conversions.
- Update `docs/functions.md` with the definition above (integers within the bounds, fractional bounds round inward, NULL or non-finite bound gives no rows, values past 2^53 are exact) and fix `docs/sql-functions.md` to `generate_series(start, stop)`.
- Run `yarn workspace @quereus/quereus test`, then `yarn workspace @quereus/quereus lint`. Also run `yarn test` from the root, since `quereus-store` tests and materialized view bodies use this function.
