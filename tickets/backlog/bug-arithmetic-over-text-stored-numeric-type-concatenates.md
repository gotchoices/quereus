description: When a plugin registers a numeric type whose values are stored as text (a decimal kept as a string, say), adding two such values joins the strings instead of adding the numbers, and the query returns NULL. Multiplying them happens to work, so the same column gives a right answer for one operator and a wrong one for another.
architecture: docs/types-inference.md#binary-operator-result-types
files:
  - packages/quereus/src/runtime/emit/binary.ts  # buildNumericOpSpec: the `leftLogical.isNumeric && rightLogical.isNumeric` arm (~line 240) selects runNumericOnly
  - packages/quereus/src/types/builtin-types.ts  # numericPromotionClass: the planner's classifier, which gives such a type no class
  - packages/quereus/src/core/database.ts  # registerType: accepts isNumeric with any physicalType
repro: verified
severity: wrong-result
likelihood: unusual
tradeoffs: No in-tree type is numeric and stored as text, so this only bites a plugin that registers one; a maintainer may prefer to forbid that combination at registration over making arithmetic handle it.
----

# Arithmetic over a TEXT-stored numeric type concatenates

## What happens

`buildNumericOpSpec` (`runtime/emit/binary.ts`) picks its fast body, `runNumericOnly`, whenever both operands' types say `isNumeric`. That body assumes the values are `number` or `bigint`: it applies the JS operator directly and nulls any result that is not a finite number. A plugin type registered with `isNumeric: true` and `physicalType: PhysicalType.TEXT` holds strings, so:

- `a + b` over `('1.5', '2')` computes the string `'1.52'`, which fails `Number.isFinite`, so the query returns NULL.
- `a * b` over the same row returns 3, because JS `*` coerces strings to numbers.

Verified on 2026-11-14 with `{ ...TEXT_TYPE, name: 'PRBTXT', physicalType: PhysicalType.TEXT, isNumeric: true, isTextual: false }`, table `t (id integer primary key, a prbtxt, b prbtxt)`, row `(1, '1.5', '2')`, query `select a + b as s, a * b as m from t` → `[null, 3]`.

The announced type is not wrong: since `arithmetic-promotes-custom-numeric-types-by-physical-type`, the planner's `numericPromotionClass` gives a TEXT-stored type no numeric class, so both expressions announce `ANY`, which every value inhabits. The values themselves are wrong.

## Expected

Arithmetic over such a type either produces the numbers its values denote (`'1.5' + '2'` → 3.5, as `buildCoercingArithmeticRun` already does for a plain TEXT operand), or the combination is refused before any query runs.

## What would settle it

The planner and the evaluator disagree about what `isNumeric` promises: the planner (since the prereq) reads it together with `physicalType`, the runtime reads it alone. Two candidate fixes:

- Dispatch `runNumericOnly` on `numericPromotionClass` for both operands instead of on `isNumeric`, so a type with no class takes the coercing body. This matches the documented rule that one classification is read by both the planner and the evaluator. Other consumers that treat `isNumeric` as "values are `number | bigint`" (the comparison fast path at `binary.ts` ~line 295, the aggregates admitted by `isSummableType`) have not been audited for the same assumption.
- Have `db.registerType` reject `isNumeric: true` unless `physicalType` is INTEGER or REAL, which makes the state unrepresentable. This is the stronger fix but changes the plugin contract, and a host may have a reason to mark a text-stored decimal numeric (for example to pass the `sum` argument check).
