description: Adding or multiplying two values of a registered custom numeric type (for example a length stored as a fraction) used to report the result as a whole-number type even though the value had a fractional part. Type promotion now follows what the custom type is stored as, not its name.
architecture: docs/types-inference.md#binary-operator-result-types
files:
  - packages/quereus/src/types/builtin-types.ts  # NumericPromotionClass + numericPromotionClass()
  - packages/quereus/src/planner/nodes/scalar.ts  # promoteNumericArithmetic(); BinaryOpNode.generateType arithmetic arm
  - packages/quereus/src/types/representation.ts  # buildConformanceCheck cross-reference
  - packages/quereus/test/binary-op-static-type.spec.ts  # plugin-registered numeric operand cases
  - docs/types-inference.md  # § Binary operator result types
  - docs/types.md  # Type Inference file list
----

# Arithmetic promotes a custom numeric type by its physical type

## What landed

`BinaryOpNode.generateType` used to choose an arithmetic result type by comparing operand type names with `NUMERIC` and `REAL`, so every other numeric type fell into "both INTEGER". A REAL-stored plugin type `LENGTH` announced `len * len` as INTEGER while producing 2.25.

Each operand is now classified by `numericPromotionClass` (`types/builtin-types.ts`):

- not `isNumeric` → no class
- name `NUMERIC` → `'NUMERIC'` (by name, the same rule and caveat as `buildConformanceCheck`; the two sites cross-reference each other)
- `physicalType` REAL → `'REAL'`; INTEGER → `'INTEGER'`
- any other storage → no class, and the expression announces `ANY`

When both operands have a class, `promoteNumericArithmetic` (`planner/nodes/scalar.ts`) applies the old promotion chain keyed on classes. The `+ - *` nullability exception now requires two INTEGER-class operands. TIMESTAMP is not `isNumeric`, so it stays out of that exception. Behaviour for the builtin types is unchanged: only INTEGER, REAL and NUMERIC are `isNumeric` in the tree.

Tests (`test/binary-op-static-type.spec.ts`, "arithmetic over plugin-registered numeric types promotes by physical type") register a REAL-stored `BOPLEN` and an INTEGER-stored `BOPCOUNT`, check the announced type and that the produced value conforms to it, and check non-nullable `a + b` over two `bopcount not null` columns.

The ticket also filed `backlog/bug-arithmetic-over-text-stored-numeric-type-concatenates`: at runtime, arithmetic over an `isNumeric` type stored as TEXT concatenates for `+`, because `buildNumericOpSpec` dispatches on `isNumeric` alone. The `ANY` announcement covers those values, but the values are wrong.

## Review findings

Read the `ticket(implement): arithmetic-promotes-custom-numeric-types-by-physical-type` diff before the handoff, then the surrounding `generateType`, `buildConformanceCheck`, `admissibleForms` (`runtime/strict-representation.ts`) and the type registry.

- **Correctness.** Checked the classifier against every builtin `isNumeric` type (only INTEGER, REAL, NUMERIC set it; TIMESTAMP deliberately does not), the temporal case (still evaluated first, and it treats an `isNumeric && !isTemporal` operand as a number, so plugin types do not change it), the mixed REAL/INTEGER pair (still NUMERIC, because `mixedBigIntArithmetic` acts on values and so applies to plugin types too), and the nullability exception (an INTEGER-physical plugin type is held to `INTEGER_CONFORMS` by the R2 write-path check, so the "safe integer or bigint" premise holds). No defects found.
- **Agreement with R2.** `numericPromotionClass` and `buildConformanceCheck` make the same NUMERIC-by-name / physicalType split; a third site, `admissibleForms` in `runtime/strict-representation.ts`, makes it too. All three share the existing "plugin REAL type named NUMERIC" caveat, already parked as a `NOTE:` on `buildConformanceCheck`. Nothing new to file.
- **Other name- or identity-keyed numeric sites.** `mergeSetOpColumnType`'s `isBuiltinNumeric` (identity) sends a plugin numeric type to ANY. That over-widens but is never wrong, and an existing `NOTE:` covers it. `comparison-coercion.ts` `textCoercionTarget` is a different question. Neither is in this ticket's scope; whether custom types should survive arithmetic and merging belongs to `blocked/feat-custom-numeric-type-survives-arithmetic-and-sums`.
- **Docs.** `docs/types-inference.md` is accurate after the change. Fixed inline: the Type Inference file list in `docs/types.md` named a nonexistent `promoteNumericTypes` in `common/type-inference.ts`, credited `findCommonType` to the wrong file, and pointed at a moved `planner/build-function-call.ts`. It now lists `numericPromotionClass`, `inferLogicalTypeFromValue`, `findCommonType` in `func/builtins/scalar.ts`, and `planner/building/function-call.ts`. This was stale before this ticket.
- **Tests.** The two new tests reproduce the reported bug (REAL-stored) and check the nullability contract the lens prover relies on (INTEGER-stored). Both pass the bar, so none were cut and none were added. They register into the global, case-insensitive type registry on every test; re-registration only logs at debug level, and the names do not collide with other specs.
- **Hygiene, typing, DRY.** Pulling `promoteNumericArithmetic` out as a function shortened `generateType`. The class is a closed string union with no `any`, and the comments explain reasons rather than restating the code. No resource or error-handling surface was touched. No findings.
- **Tripwires / new tickets.** None. The TEXT-stored runtime defect is already filed in backlog by the implementer.
- **Validation.** `yarn workspace @quereus/quereus lint`: clean. `yarn workspace @quereus/quereus test`: 11148 passing, 26 pending, 0 failing. I did not run the new tests against the pre-change code; reading the old name-keyed chain shows they would have announced INTEGER and nullable `true`.
