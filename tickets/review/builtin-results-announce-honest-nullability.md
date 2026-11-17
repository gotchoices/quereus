description: Many built-in functions (abs, round, lower, length, substr, trim and others) told callers their result could never be null, yet returned null for a null or unusable argument. Each now announces null-possibility from what is known about its arguments; review the derivation, the per-function choices, and three small runtime fixes made along the way.
architecture: docs/types.md#enforcement-quereus_repr_strict
files:
  - packages/quereus/src/func/builtins/return-types.ts      # nullPropagatingReturn + the four argument-type predicates
  - packages/quereus/src/func/builtins/scalar.ts            # abs, round (1 and 2 args), floor, ceil, ceiling
  - packages/quereus/src/func/builtins/string.ts            # length, substr/substring, instr, replace, trim family, lower, upper, reverse, lpad/rpad
  - packages/quereus/src/planner/nodes/scalar.ts            # UnaryOpNode '~' arm
  - packages/quereus/src/index.ts                           # exports the helper and predicates for plugins
  - packages/quereus/test/announced-result-types.spec.ts    # registry sweep test
  - docs/plugins.md                                         # § Declaring return types
  - docs/types-inference.md                                 # abs/sqrt examples, helper description
----

# Built-in functions announce whether their result can be null, truthfully

## What changed

`Statement.getColumnDefs()[i].type.nullable === false` is a promise the column never yields NULL; LIMIT/OFFSET validation and the lens prover (`lens.nullability-mismatch`) act on it. Many builtins hard-coded `nullable: false` while returning NULL for a NULL argument or an argument they cannot use.

**Helper** — `nullPropagatingReturn({ logicalType, accepts?, minArgs? })` in `func/builtins/return-types.ts` builds an `inferReturnType`. Result is non-null only when `argNullable` was passed, every argument is non-null, the call has at least `minArgs` arguments, and each argument's type passes its `accepts[i]` predicate (no entry = accepts everything). Predicates read the logical type's `physicalType`: `isTextValued` (TEXT — so DATE/TIME/TIMESPAN pass), `isTextOrBlobValued`, `isNumberValued` (INTEGER/REAL physical), `convertsToNumber` (those plus BOOLEAN). Fresh object per call. Exported from the package index alongside the `*_RETURN` constants.

**Per function**

| function | accepts | notes |
|---|---|---|
| `abs`, `floor`, `ceil`/`ceiling`, 1-arg `round` | arg0 `convertsToNumber`; type = arg0's | shared `numericPreservingReturn` |
| 2-arg `round` | — | always nullable (`scalarReturn(argTypes[0])`): `round(1.7e308, -308)` overflows to NULL and the planner cannot see the sign of the places argument |
| `length` | `isTextOrBlobValued` | |
| `substr`/`substring` | start, length `convertsToNumber`; `minArgs: 2` | one-arg `substr('abc')` was always NULL; NULL length over-claimed |
| `instr`, `replace`, `trim`/`ltrim`/`rtrim` | everything (they `String()` their args) | `trim(s, null)` over-claimed |
| `lower`, `upper`, `reverse` | `isTextValued` | |
| `lpad`, `rpad` | str/pad `isTextValued`, length `isNumberValued` | |
| unary `~` | — | `nullable = true` when operand is not `isNumeric` |

`textReturnTypeInference` and `substrTypeInference` are deleted, as is the stale comment above `hex()`.

**Runtime changes (deliberate — please scrutinize)**

- `round`: previously leaked NaN/±Infinity (`round(1e308, 10)` → Infinity, `round(0, 400)` / `round(5, -400)` → NaN, both announced non-null INTEGER/REAL). Now `roundToPlaces`: scaled overflow → x unchanged (already rounded at that place), factor underflow to 0 → 0, a genuinely overflowing result → NULL. The dead `try/catch` around `Math.pow` was removed. A `bigint` argument with places ≥ 0 is returned unchanged.
- `floor`/`ceil`: a `bigint` argument is returned unchanged. Before, `floor(9007199254740993)` returned the unsafe number `9007199254740992` (lost precision, non-canonical), and a bigint past the double range became Infinity. Needed so INTEGER-typed 1-arg `round` can stay non-null; floor/ceil changed with it to match.
- `abs`/`floor`/`ceil`: `isNaN` → `!Number.isFinite`, so `'Infinity'` text via an ANY argument is NULL rather than an escaped Infinity. Only reachable through ANY/NULL-typed args (already announced nullable).
- `lpad`/`rpad`: now accept a `bigint` length (before, any out-of-safe-range INTEGER made them NULL). A huge positive one hits `repeat()`'s "Invalid string length" error, same as a huge `number` length already did. Also fixed a bug found while editing: `lpad('**', 4, '*')` returned `'**'` because the old code compared the computed padding to the input string by value (`padding === str`) to mean "no padding needed". Now `'****'`. Refactored into `createPadFunc` (like `createTrimFunc`).

## Audit of the remaining non-null builtins

Read each: `typeof` (always returns a type name), `random`, `json_valid` (NULL → false), `json_schema` (both default and cached-emitter paths return a boolean), `IsISODate`/`IsISODateTime` (non-string → false), `mutation_ordinal` (returns the ordinal or throws). All are total. `generate_series` and the explain/schema table-valued functions are out of scope (relation columns, not scalar inference). The aggregate/window `_NOT_NULL` users (count, total, row_number, …) are out of scope as the ticket says.

## Test added

- `test/announced-result-types.spec.ts` › "scalar builtins over NULL arguments › never yield NULL where they announce non-null" — iterates `BUILTIN_FUNCTIONS` filtered by `isScalarFunctionSchema`; for fixed arity calls `f(null, …)`, for variadic tries 1–3 args, skipping arities rejected at prepare. A fixed-arity function that fails to prepare is reported as a violation (keeps the sweep from going vacuous). An execution error counts as "not NULL" (`mutation_ordinal()` outside a mutation). Mutation-checked: reverting `lower`/`upper`/`reverse` to `nullable: false` fails it with all three named.

No per-function tests, as the ticket specifies. The refusal half (non-null argument of a type the function cannot use) is not covered mechanically; it is meant for the statement-egress check (`announced-nullability-egress-check`).

## Validation

- `yarn workspace @quereus/quereus lint` — clean.
- `yarn workspace @quereus/quereus test` — 11188 passing, 23 pending, 0 failing.
- `yarn test` (all workspaces) — all green.
- No existing test relied on the over-claim. The ticket's anticipated fallout (LIMIT `length(?)`, lens tests) did not show up as failures; `55-lens-prover.sqllogic` and the `lens-*.spec.ts` files pass unchanged.

Spot-checked by hand (not kept as tests): `lower(not_null_text)` and `lower(not_null_date)` announce non-null; `lower(nullable_text)`, `lower(5)`, `length(2)`, `~'abc'`, `substr('abc')` announce nullable and yield NULL; `upper(s) || 'x'` over a NOT NULL column stays non-null.

## Things for the reviewer to weigh

- **2-arg round is always nullable.** That means a lens `not null` column over `round(price, 2)` with NOT NULL `price` now raises `lens.nullability-mismatch`. The alternative was exact bigint rounding for negative places plus treating only REAL x as overflow-capable. That would still be nullable for REAL x, because REAL addition is already nullable for the same overflow reason. Judged not worth it; a `coalesce` wrap is the workaround.
- **Predicates use physical type, not `isNumeric`** (the ticket table said `isNumeric` for the numeric args). For abs/floor/ceil/round, `validateArgTypes` already limits arguments to numeric/ANY/NULL, so the result is the same. For `substr`, BOOLEAN and TIMESTAMP start/length args are now accepted, which is correct because `Number()` converts them.
- `hex()` still declares `TEXT_RETURN` (nullable) though it throws, rather than nulls, for unconvertible input. That over-claims, which is sound. It is left alone because which inputs `BLOB_TYPE.parse` returns null for was not audited.
- The `docs/types.md` paragraph pointing at `debt-announced-nullability-disagrees-with-produced-nulls` and the matching comment in `core/statement.ts` `_iterateWithSignal` still describe builtins as one violation class. Left for that parent ticket and `announced-nullability-egress-check` to update when the check lands.
