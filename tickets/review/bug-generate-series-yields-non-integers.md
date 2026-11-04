description: The built-in number-series table function now produces exactly the whole numbers between its two bounds, instead of fractions, wrong or endlessly repeated values past 2^53, and a series that read a missing bound as zero. Review the fix.
architecture: docs/types.md#physical-representation
files:
  - packages/quereus/src/func/builtins/generation.ts       # the only code change: seriesBound, seriesRange, nextSeriesInteger, generator, estimatedRows
  - packages/quereus/test/logic/03.5-tvf.sqllogic          # new cases appended at the end
  - docs/functions.md                                      # generate_series entry
  - docs/sql-functions.md                                  # removed a step argument that does not exist
repro: verified
----

`generate_series(start, stop)` declares one non-null INTEGER column `value`, advertised as a strictly ascending key. It used to convert both bounds with `Number(...)` and count in floating point, which made that declaration false. The series is now exactly the integers `n` with `start <= n <= stop`, ascending.

## What changed

Each bound goes through `NUMERIC_TYPE.parse`, then rounds inward (`Math.ceil` for start, `Math.floor` for stop), then `canonicalizeInteger`. The counter stays a `number` inside the safe range and becomes a `bigint` outside it, so every value follows rule R1 in `docs/types.md` and the counter always advances. It also narrows back to `number` when a negative series climbs into the safe range. `estimatedRows` uses the same conversion, which replaces its four mixed-type branches with one.

## Behaviour to check

| query | result | before |
|---|---|---|
| `generate_series(0.5, 3)` | `1, 2, 3` | `0.5, 1.5, 2.5` |
| `generate_series(-2.5, -0.5)` | `-2, -1` | `-2.5, -1.5, -0.5` |
| `generate_series(-0.5, 0.5)` | `0` (not `-0`) | not run; from the old code, `-0.5, 0.5` |
| `generate_series(1, 3.5)` | `1, 2, 3` | same |
| `generate_series(null, 3)` / `(-2, null)` | no rows | `0, 1, 2, 3` / `-2, -1, 0` |
| `generate_series(1, null)` | no rows | same |
| `generate_series(1, 1e400)` | no rows | endless; out of memory without a limit |
| `generate_series(-1e400, 1)` | no rows | `-Infinity` repeated forever (not in the original ticket's table) |
| `generate_series('', 1)` | no rows | `0, 1` |
| `generate_series('abc', 4)` | error `Table-valued function generate_series failed: Cannot convert 'abc' to NUMERIC` | no rows |
| `generate_series(x'00', 4)` | error `... Cannot convert object to NUMERIC` | `0, 1, 2, 3, 4` |
| `generate_series(9007199254740990, 9007199254740993)` | `...990, ...991, ...992n, ...993n` | `...992` repeated forever |
| `generate_series(-9007199254740993, -9007199254740990)` | four rows, exact, last two are `number` | three rows, first one wrong |

## Tests added

All in `packages/quereus/test/logic/03.5-tvf.sqllogic`:

- `(0.5, 3)`, `(-2.5, -0.5)`: a fractional start rounds up, on both sides of zero, and a fractional stop rounds down.
- `(1, 3.5)`: a fractional stop keeps its current result.
- `(-0.5, 0.5)`: the rounded start is `0`, not `-0`. This pins the `+ 0` in `seriesBound`.
- `(null, 3)`, `(-2, null)`, `(1, null)`: a NULL on either side gives no rows.
- `(1, 1e400)`, `(-1e400, 1)`: an infinite bound on either side gives no rows.
- `('', 1)`: empty text converts to NULL, so no rows.
- `('2', '3.5')`: text bounds read as numbers, including rounding.
- `('abc', 4)`, `(x'00', 4)`: non-numeric text and a blob raise the conversion error.
- Ascending across 2^53, starting below -2^53, and digit text past 2^53: values stay exact. These compare `cast(value as text)`, because the harness rounds a bigint through `Number()`, and carry a `limit` above the expected row count so a regression fails instead of hanging.
- Correlated `p.pid < g.value` against a memory table with integer primary key: the original lamina scenario, expected `[1,0], [2,1], [3,2]`.

## Validation

- `yarn workspace @quereus/quereus test`: 10985 passing, 25 pending.
- `yarn workspace @quereus/quereus lint`: exit 0.
- `yarn test` from the root: exit 0, no failures in any workspace.
- Not run: `yarn test:store` and `yarn test:repr-strict`.

## Known gaps for the reviewer

- **`estimatedRows` has no new automated test.** A literal series is constant-folded before a plan can show the estimate, so `query_plan` reports the folded row count, not this closure's result. Testing it would mean calling the closure with hand-built plan nodes. I ran it that way once in a throwaway script: `(0.5, 3)` gives 3, `(1, 3.5)` gives 3, `(-2.5, -0.5)` gives 2, `(5, 1)`, a NULL bound and `(1, 1e400)` give `undefined`, `(9007199254740990, 9007199254740993n)` gives 4, and `('abc', 4)` throws, which `resolveAdvertisement` catches. The existing specs in `test/planner/tvf-physical-properties.spec.ts` stay green.
- **Bound parameters were checked only in a throwaway script.** The harness's `-- params:` line is JSON and cannot carry a bigint. `(?, ?)` with `9007199254740990, 9007199254740992n` gave three exact rows, `-9007199254740993n, -9007199254740990` gave four, `(0.5, 3)` gave `1, 2, 3`, and `NaN` gave no rows. Parameters and literals reach the same generator.
- **How failure was confirmed before the fix.** The harness stops a file at its first failure, so through the harness I only saw the `(0.5, 3)` case fail. I ran the other queries against the unfixed build with a `limit`, and they gave the wrong results in the table above. The `(-0.5, 0.5)` and correlated cases were not run against the old code.
- **One behaviour change the original ticket did not list.** `generate_series('2abc', 3)` used to give no rows and now gives `2, 3`, because `NUMERIC_TYPE.parse` falls back to `parseFloat`, which reads a leading number. The ticket chose that conversion, so I kept it and documented it in `docs/functions.md`.
- **A huge finite literal stop still exhausts memory.** `generate_series(1, 1e300)` is finite, so it is no longer an infinite loop, but constant folding still tries to buffer it. I did not run this without a limit. That is `backlog/bug-constant-folded-relation-buffers-every-row`, out of scope here.
- **Existing callers.** The original ticket searched every `generate_series` call under `packages/` and found only starts of literal `1`. It left column and parameter stops individually unchecked, and the passing test run is what confirms them.
