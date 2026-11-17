description: Many built-in functions (abs, round, lower, length, substr, trim and others) told callers their result could never be null, yet returned null for a null or unusable argument. Each now announces null-possibility from what is known about its arguments.
architecture: docs/types.md#enforcement-quereus_repr_strict
files:
  - packages/quereus/src/func/builtins/return-types.ts      # nullPropagatingReturn + the four argument-type predicates
  - packages/quereus/src/func/builtins/scalar.ts            # abs, round (1 and 2 args), floor, ceil, ceiling
  - packages/quereus/src/func/builtins/string.ts            # length, substr/substring, instr, replace, trim family, lower, upper, reverse, lpad/rpad
  - packages/quereus/src/planner/nodes/scalar.ts            # UnaryOpNode '~' arm
  - packages/quereus/src/index.ts                           # exports the helper and predicates for plugins
  - packages/quereus/test/announced-result-types.spec.ts    # registry sweep test + ±Infinity regression test
  - docs/plugins.md, docs/types-inference.md, docs/functions.md, docs/sql-functions.md
----

# Built-in functions announce whether their result can be null, truthfully

## What was built

`Statement.getColumnDefs()[i].type.nullable === false` promises the column never yields NULL; LIMIT/OFFSET validation and the lens prover (`lens.nullability-mismatch`) act on it. Builtins that hard-coded `nullable: false` while nulling a NULL or unusable argument now derive the flag per call.

- `nullPropagatingReturn({ logicalType, accepts?, minArgs? })` in `func/builtins/return-types.ts` builds an `inferReturnType`: non-null only when `argNullable` is supplied, every argument is non-null, the call has at least `minArgs` arguments, and each argument's type passes its `accepts[i]` predicate. Predicates read `physicalType`: `isTextValued`, `isTextOrBlobValued`, `isNumberValued`, `convertsToNumber`. Exported from the package index for plugins.
- abs/floor/ceil/1-arg round: arg0 `convertsToNumber`, type = arg0's. 2-arg round: always nullable (rounding to a negative place count can overflow). length: text/blob. substr: start/length `convertsToNumber`, `minArgs: 2`. instr/replace/trim family: accept everything (they `String()` arguments). lower/upper/reverse: text. lpad/rpad: text, number, text. Unary `~`: nullable when its operand is not numeric.
- Runtime fixes: `round` no longer leaks NaN/±Infinity from its scaling (`roundToPlaces`); floor/ceil/round return a `bigint` argument unchanged instead of losing low digits; lpad/rpad accept a `bigint` length and `lpad('**', 4, '*')` now pads (it compared padding to input by value).

## Review findings

Read the diff of `ticket(implement): builtin-results-announce-honest-nullability` first, then probed edge cases with a throwaway spec (deleted) over NOT NULL REAL/TEXT/JSON/TIMESTAMP/BOOLEAN/INTEGER columns.

- **Fixed — regression introduced by the implement pass (major, fixed inline).** The implementer changed abs/floor/ceil from `isNaN` to `!Number.isFinite`, stating this was only reachable through ANY-typed arguments. It is not: a REAL value can be ±Infinity (`select 1e999` announces non-null REAL and yields Infinity, and `insert ... values (1e999)` stores it in a `real not null` column). After the change, `abs(x)`, `floor(x)`, `ceil(x)` and `round(x)` over such a column announced non-null and yielded NULL — a new instance of exactly the lie this ticket removes (before the change they returned Infinity). Fix in `scalar.ts`: back to `isNaN`, and `roundToPlaces` returns ±Infinity unchanged instead of nulling it; comments at `numericPreservingReturn` and `roundToPlaces` state why. Added one regression test, `announced-result-types.spec.ts` › "numeric builtins over a stored ±Infinity", verified against the pre-fix code (all four yielded NULL there).
- **Docs (minor, fixed).** `docs/functions.md` `round(X, Y)` now says Y may be negative and the result is NULL on overflow past the REAL range. `docs/sql-functions.md` listed `lpad`/`rpad` with an optional pad defaulting to space; both take exactly three arguments (calling with two is rejected at prepare), so the signature was corrected.
- **Checked, no change:** every `inferReturnType` call site for scalar functions (`planner/nodes/function.ts` `inferScalarCallType`, used by the builder and `withChildren`) passes `argNullable`, so the "no `argNullable` → nullable" branch only affects plugin callers and is sound. JSON (physical OBJECT) arguments to lower/length announce nullable and yield NULL — correct. TIMESTAMP (physical INTEGER) as a substr/lpad numeric argument converts through `Number()` — correct. `~` over INTEGER/REAL including ±Infinity and bigint yields a value — matches the non-null announcement. `round(5, -400)`, `round(0, 400)`, `round(1.7e308, -308)`, `round(1e308, 10)` give 0, 0, NULL, 1e308.
- **Observed, already tracked:** `replace`/`trim`/`instr` over a JSON object stringify it as `[object Object]` — a wrong result, but not a nullability issue, and it is covered by `debt-string-builtins-coerce-three-different-ways` (cited in `docs/functions.md`). No new ticket.
- **Implementer's open questions:** 2-arg `round` always nullable — accepted; it is sound, and wrapping in `coalesce` restores non-null where the caller knows a fallback. Physical-type predicates instead of `isNumeric` — agreed, they describe what the implementation's `Number()`/`typeof` checks actually accept. `hex()` over-claiming nullable — sound, left alone. `docs/types.md` / `core/statement.ts` comments about the builtin violation class — left to `announced-nullability-egress-check` as the handoff said.
- **Tests:** the registry sweep test pays for itself (it enumerates future builtins and was mutation-checked by the implementer); kept. No other tests added or cut.
- **Hygiene / DRY / types:** `createPadFunc` mirrors `createTrimFunc`; deleted helpers left no stale references (grepped `textReturnTypeInference`, `substrTypeInference`). The `as LogicalType` cast in `roundFunc2` matches surrounding usage. No resource-cleanup or error-handling concerns in the diff; the test's swallowed exceptions are deliberate and commented.
- **Tripwires:** none recorded — no conditional concerns found.

## Validation

- `yarn workspace @quereus/quereus lint` — clean.
- `yarn test` (all workspaces) — green; `@quereus/quereus` 11189 passing, 23 pending, 0 failing.
