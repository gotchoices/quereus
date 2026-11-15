description: Adding or multiplying two values of a registered custom numeric type (for example a length stored as a fraction) reports the result as a whole-number type even though the value has a fractional part. Type promotion has to follow what the custom type is stored as, not its name.
architecture: docs/types-inference.md#binary-operator-result-types
files:
  - packages/quereus/src/planner/nodes/scalar.ts  # BinaryOpNode.generateType, the 'arithmetic' case (~lines 214-283): bothInteger nullability check and the promotion chain decided by name
  - packages/quereus/src/types/builtin-types.ts  # home for the new classifier, next to isNumericOrUnknownType / NUMERIC_TYPE
  - packages/quereus/src/types/representation.ts  # buildConformanceCheck: the same "NUMERIC by name, otherwise by physicalType" rule the classifier must mirror
  - packages/quereus/test/binary-op-static-type.spec.ts  # existing announced-type + conformsToType tests; add the custom-type cases here
  - docs/types-inference.md  # § Binary operator result types, promotion table
repro: verified
----

# Arithmetic promotes a custom numeric type by its physical type

## The defect

`BinaryOpNode.generateType` (`packages/quereus/src/planner/nodes/scalar.ts`, arithmetic arm) picks the result type of two numeric operands by comparing their type **names** with `'NUMERIC'` and `'REAL'`. Anything that is neither name falls into the final branch, which says "both are INTEGER". A custom type registered with `db.registerType` whose `physicalType` is `REAL` and `isNumeric: true` is neither name, so arithmetic over two of them, or over one of them and an integer, announces `INTEGER` for a fractional value.

Reproduced on this checkout's HEAD (2026-11-14) with `LENGTH` registered as `{ ...REAL_TYPE, name: 'LENGTH', physicalType: PhysicalType.REAL, isNumeric: true }`, table `T (id integer primary key, len length, plain real)` holding `(1, 1.5, 2.5)`, reading `Statement.getColumnType(0)`:

| Expression | Announced now | Value | Announced after the fix |
|---|---|---|---|
| `len * 2` | INTEGER | 3 | NUMERIC (REAL × INTEGER is mixed) |
| `len * 2.0` | INTEGER | 3 | NUMERIC |
| `len + len` | INTEGER | 3 | REAL |
| `len * len` | INTEGER | **2.25** | REAL |
| `len / 2` | NUMERIC | 0.75 | NUMERIC |
| `len + plain` | NUMERIC | 4 | REAL |

`len * 2.0` lands in the INTEGER branch because the literal `2.0` is itself announced INTEGER (the lexer stores it as the integral number 2), so neither operand is named REAL or NUMERIC. That is correct for the literal and not part of this fix.

With `isNumeric` left unset the operands are not numeric, arithmetic announces `ANY` (correct by the documented third arm), and `sum(len)` is rejected at plan time by `validateSummableArg`. Neither is changed here.

The INTEGER announcement is a wrong answer, not just an imprecise one: the R2 representation check (`conformsToType`, `types/representation.ts`) rejects 2.25 as an INTEGER, so `QUEREUS_REPR_STRICT` would fail on it, and a DML write sourced from `len * len` into a column of that announced type would trust it.

## The fix

Classify each numeric operand into the built-in promotion class its value space belongs to, then run the existing promotion table on the classes instead of the names:

- name `NUMERIC` → NUMERIC. Matched by name for the same reason `buildConformanceCheck` does: NUMERIC shares REAL's `physicalType` and only its name says it admits `bigint`.
- otherwise `physicalType` `REAL` → REAL
- otherwise `physicalType` `INTEGER` → INTEGER
- anything else (an `isNumeric` type stored as TEXT, BOOLEAN, OBJECT or NULL) → no class, so the pair falls to the existing `ANY` arm. The runtime coerces such values per row, and nothing narrower can be announced.

The classifier must agree with `buildConformanceCheck` about which value space a type has. It belongs in `types/builtin-types.ts` (or beside `buildConformanceCheck`), with a comment that points to the other site. Mixed REAL/INTEGER classes still announce NUMERIC. The planner comment explains why: a `bigint` INTEGER operand survives against an integral REAL value. A custom INTEGER-physical type is in the same position.

Use the same classifier in the `bothInteger` nullability check at the top of the arm. Two INTEGER-physical custom operands under `+ - *` keep their operands' nullability, the same as two INTEGERs. By R2, an INTEGER-physical value is a safe integer or a `bigint`, so the argument the existing comment gives holds unchanged. The lens prover relies on this exception, so keep it exactly as narrow as the INTEGER class.

The result is still a **built-in** type. Whether a custom type should be preserved through arithmetic and aggregates (`len + len` → LENGTH) is a separate design question, filed as `blocked/feat-custom-numeric-type-survives-arithmetic-and-sums`. This ticket only makes the announcement true.

The runtime (`runtime/emit/binary.ts` `buildNumericOpSpec`) chooses its body on `isNumeric` rather than on names, so it needs no change. The announcement is the only thing that is wrong.

## Tests

The sqllogic suite cannot register a custom type, so the reproduction goes in `test/binary-op-static-type.spec.ts`, which already pairs the announced type with `conformsToType` on the produced value (`expectAnnouncedAndInhabited`). Its helper evaluates `select <expr> as v` with no table, so the custom-type cases need a table with a custom-typed column, or a `cast(1.5 as length)` operand if that announces LENGTH (the original measurement showed it does). Add one `describe` for custom numeric operands:

- REAL-physical custom type: `c + c` and `c * c` → REAL, `c * 2` → NUMERIC, `c + plain_real` → REAL, each with a fractional value that conforms.
- INTEGER-physical custom type: `c + c` → INTEGER, `c / c` → NUMERIC.

That is one test per promotion rule the classifier changes. Do not add tests for the TEXT-physical `isNumeric` arm beyond one case, if any.

## TODO

- Add the operand-class helper (NUMERIC by name, else REAL/INTEGER by `physicalType`, else none) next to the existing numeric-type helpers, with a comment naming `buildConformanceCheck` as the rule it mirrors.
- Rewrite the promotion chain and the `bothInteger` check in `BinaryOpNode.generateType` to use it; keep the existing explanatory comments, reworded from type names to classes.
- Add the custom-type cases to `test/binary-op-static-type.spec.ts`.
- Update the promotion table in `docs/types-inference.md` § Binary operator result types so it says operand *classes*, and add one sentence on how a custom type is classified.
- Run `yarn workspace @quereus/quereus test` and `yarn workspace @quereus/quereus lint`.
