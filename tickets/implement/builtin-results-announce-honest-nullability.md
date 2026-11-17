description: Many built-in functions (abs, round, lower, length, substr, trim and others) tell callers their result can never be null, yet they return null whenever an argument is null or is a kind of value they cannot use. Make each one announce null-possibility truthfully, from what is known about its arguments.
architecture: docs/types.md#enforcement-quereus_repr_strict
files:
  - packages/quereus/src/func/builtins/return-types.ts      # add the shared null-derivation helper here
  - packages/quereus/src/func/builtins/scalar.ts            # abs, round (1 and 2 args), floor, ceil, ceiling
  - packages/quereus/src/func/builtins/string.ts            # length, substr/substring, instr, textReturnTypeInference (trim, ltrim, rtrim, replace, lower, upper, reverse, lpad, rpad)
  - packages/quereus/src/planner/nodes/scalar.ts            # UnaryOpNode '~' over a non-numeric operand
  - packages/quereus/src/runtime/emit/unary.ts              # '~' runtime — returns NULL for a non-numeric operand (read-only reference)
  - packages/quereus/src/planner/nodes/function.ts          # inferScalarCallType — already passes argNullable; read-only reference
  - packages/quereus/src/func/builtins/index.ts             # BUILTIN_FUNCTIONS — the registry the sweep test iterates
  - packages/quereus/test/announced-result-types.spec.ts    # home for the registry sweep test
  - docs/plugins.md                                         # § Declaring return types — mention argNullable for inferReturnType
----

# Built-in functions announce whether their result can be null, truthfully

## Background

`Statement.getColumnDefs()[i].type.nullable === false` promises an embedder the column never yields NULL. The planner also reads the flag: `LIMIT`/`OFFSET` reject a nullable expression at prepare time (`planner/building/row-count-expression.ts`), and the lens prover (`schema/lens-prover.ts` `checkTypeAndNullability`) only raises `lens.nullability-mismatch` when a basis expression reports `nullable === true`. So an over-claim of non-null lets a `not null` logical column over `lower(<nullable column>)` deploy clean and then read NULL.

A suite run on 2026-11-16 with a temporary "announced non-nullable ⇒ no null cell" check at statement egress found 76 distinct violating columns; most of them are this class. Violating calls seen: `abs`, `round` (1 and 2 args), `floor`, `ceil`, `ceiling`, `instr`, `length`, `substr`, `trim`, `ltrim`, `rtrim`, `replace`, `lower`, `upper`, `reverse`, `lpad`, `rpad`, and unary `~'abc'`. Several more columns violated only because they were built on top of these (`case … lower(s) …`, `lower(s) || …`, `upper(g)` over a nullable group key) — CASE and `||` derive their nullability from their operands and need no change of their own.

The documented contract (`func/builtins/return-types.ts` header; `docs/plugins.md` § Declaring return types) is that a non-null declaration means the implementation "provably cannot return null on any path". These functions break it in two ways:

1. **A NULL argument.** Every one of them returns NULL for a NULL argument but hard-codes `nullable: false` in an `inferReturnType` that ignores the second parameter `argNullable` (added by `bug-null-limit-returns-no-rows`; `coalesce` in `scalar.ts` already uses it).
2. **A non-null argument the function refuses.** `lower(5)`, `upper(x'61')`, `reverse(1)`, `lpad(1, 5, '*')` return NULL because the implementation requires a JS string; `length(2)` is NULL (only TEXT and BLOB have a length); `abs('abc')`, `floor('x')`, `ceil('x')`, `round('x')` are NULL (the `Number(...)` conversion gives NaN); `substr('abc', 'x')` is NULL for a non-numeric start or length; `~'abc'` is NULL.

## Design

Add one helper to `func/builtins/return-types.ts` that builds an `inferReturnType` from two facts, and make every function above use it instead of an object literal:

- the result logical type (a fixed type, or a function of the argument types for `abs`/`round`/`floor`/`ceil`, which preserve the argument's type);
- per argument, which argument types the implementation can use without refusing (a predicate over the argument's logical type; read the **physical** type through `getPhysicalType` where the refusal is a `typeof` check, so `lower` over a DATE — physically a string — is accepted).

The derived nullability is:

```
nullable = argNullable === undefined            // caller does not know → nullable
        || some argument is nullable
        || some argument's type fails its predicate
```

An argument with no predicate accepts every type. The result is the same derivation for every function in the family, so the next builtin added cannot hard-code `nullable: false` by copying a neighbour — it either uses the helper or declares the nullable `*_RETURN` constant.

Per-function predicates, from reading the implementations (re-check each when you edit it):

| function | refuses a non-null argument when | accept |
|---|---|---|
| `abs`, `floor`, `ceil`, `ceiling`, `round` (value arg) | `Number(x)` is NaN | numeric logical type (`isNumeric`) |
| `round` (places arg) | `Number(p)` is NaN | numeric logical type |
| `length` | physical type is neither TEXT nor BLOB | physical TEXT or BLOB |
| `substr`/`substring` (start, length args) | `Number(...)` is NaN | numeric logical type (the string arg is stringified, never refused) |
| `instr`, `replace`, `trim`, `ltrim`, `rtrim` | never (they stringify with `String(...)`) | everything |
| `lower`, `upper`, `reverse` | `typeof x !== 'string'` | physical TEXT |
| `lpad`, `rpad` | string args not a JS string, or length arg not a JS `number` | string args physical TEXT; length arg: INTEGER/REAL only if neither can arrive as a `bigint` — an out-of-safe-range INTEGER is a `bigint` and `buildPadding` refuses it, so announce nullable for an INTEGER length unless you make the implementation accept `bigint` |

Two places where exact precision would need special cases; over-claiming nullable is acceptable there and should be noted in a comment, not engineered around:

- `substr(s, y, z)` with a NULL `z` returns a value (`Number(null)` is 0), and `trim(s, null)` falls back to the default trim — treating every argument as null-propagating over-claims for those. Fine.
- `round(x, p)`: check whether `Math.round(x * 10^p) / 10^p` can produce a non-finite number for extreme `p` (e.g. `round(1e308, 400)`) and what that value becomes downstream. If it can become NULL, two-argument `round` must announce nullable whenever the places argument is not a known-safe constant. If it can escape as NaN/Infinity, that is a representation bug — fix it in the implementation (return NULL) and announce accordingly.

Unary `~` (`UnaryOpNode` in `planner/nodes/scalar.ts`): over a non-numeric operand the runtime (`runtime/emit/unary.ts`) returns NULL when the conversion gives NaN, so the `'~'` arm must set `nullable = true` when `!operandType.logicalType.isNumeric`, matching what the `'-'`/`'+'` arm already does.

Audit the rest of the builtin set while you are here: every scalar builtin whose announced type is non-null — `*_RETURN_NOT_NULL` constants (`typeof`, `random`, `json_valid`, `json_schema`, `IsISODate`, `IsISODateTime`, the mutation-count function in `mutation.ts`, `generation.ts`) and any remaining `nullable: false` literal — must actually return a value for a NULL argument. The sweep test below checks the NULL-argument half mechanically; the refusal half is by reading.

## Relationship to the string-coercion ticket

`debt-string-builtins-coerce-three-different-ways` (plan/) is deciding whether the string family should stop refusing non-text input and coerce it through `valueToText` instead. Its nullability arm moved here. When it lands, functions that stop refusing get a wider accept predicate (e.g. `lower` accepts everything) and their announcement tightens — the helper makes that a one-line change. Do not change any function's *runtime* behaviour in this ticket; only what it announces.

## Edge cases & interactions

- **LIMIT/OFFSET.** An expression that newly announces nullable is now rejected at prepare time. Parameters are judged as non-null there (`isNullableOnlyThroughParameters`), and an ANY-typed parameter is assumed to be an INTEGER — so `limit length(?)` prepared with nothing bound (or bound to a number) becomes a prepare-time error, because `length` over an INTEGER refuses. That is correct: `length(2)` is NULL, and it is exactly the case the review of `nullability-of-value-inferred-parameter-types` found failing only at execution. Prepared with a TEXT value bound first, the parameter is TEXT-typed and the LIMIT is accepted. Update any test that expected otherwise. Verify by the suite.
- **Lens prover.** A lens body column over e.g. `lower(name)` where `name` is NOT NULL TEXT must still prove NOT NULL (predicate accepts TEXT, argument non-null). Over a nullable argument it now raises `lens.nullability-mismatch` — that is the bug being fixed. Run `test/logic/55-lens-prover.sqllogic` and the `lens-*.spec.ts` files; a test that relied on the over-claim to deploy a `not null` logical column over a nullable argument should declare the logical column nullable (or wrap in `coalesce`), not be skipped.
- **Re-inference on rewrite.** `ScalarFunctionCallNode.withChildren` re-runs `inferReturnType` with the new operands, so a rewrite that makes an operand non-null tightens the result. No change needed; just don't cache the answer in the helper.
- **`argNullable === undefined`.** Synthetic call sites that do not pass it must get nullable (sound default).
- **Shared constant objects.** `return-types.ts` notes its constants are shared and never mutated; the helper returns fresh `ScalarType` objects per call.
- **Aggregates and window functions** are out of scope (different inference signature); the egress check in `announced-nullability-egress-check` will catch any that lie.

## Test

One generated test, in `test/announced-result-types.spec.ts`: iterate `BUILTIN_FUNCTIONS`, keep the scalar (non-aggregate, non-table-valued) ones, and for each declared arity (for variadic `numArgs: -1`, try 1, 2 and 3 arguments, skipping arities the function rejects at prepare) prepare `select f(null, …, null)`. If `getColumnDefs()[0].type.nullable === false`, executing must not yield NULL. Generated from the registry, not hand-listed, so a new builtin is covered without editing the test. It catches the NULL-argument half for every builtin present and future; the refusal half is covered by the egress check once it is installed. No per-function tests beyond that.

## TODO

- Add the null-derivation helper to `return-types.ts` (with a doc comment stating the rule above).
- Move `abs`, `round`×2, `floor`, `ceil`/`ceiling` in `scalar.ts` onto it.
- Move `length`, `substr`/`substring`, `instr`, and every user of `textReturnTypeInference` in `string.ts` onto it; delete `textReturnTypeInference` and `substrTypeInference`; remove the now-stale comment above `hex()` that refers to the helper's lie.
- Resolve the `round(x, p)` non-finite question and the `lpad`/`rpad` bigint length question as described.
- Fix the `'~'` arm of `UnaryOpNode`.
- Audit the remaining non-null scalar builtins.
- Add the registry sweep test.
- `docs/plugins.md` § Declaring return types: one sentence that `inferReturnType` receives `argNullable` and a function that maps NULL to NULL should derive from it rather than declare non-null.
- Run `yarn workspace @quereus/quereus test` and `yarn workspace @quereus/quereus lint`; fix fallout in tests that relied on the over-claim.
