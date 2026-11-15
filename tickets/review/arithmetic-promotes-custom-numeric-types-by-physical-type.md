description: Adding or multiplying two values of a registered custom numeric type (for example a length stored as a fraction) used to report the result as a whole-number type even though the value had a fractional part. Type promotion now follows what the custom type is stored as, not its name; this needs a review pass.
architecture: docs/types-inference.md#binary-operator-result-types
files:
  - packages/quereus/src/types/builtin-types.ts  # new NumericPromotionClass type + numericPromotionClass(), after isSummableType
  - packages/quereus/src/planner/nodes/scalar.ts  # new module-level promoteNumericArithmetic(); BinaryOpNode.generateType arithmetic arm uses the classes for both the bothInteger nullability check and promotion
  - packages/quereus/src/types/representation.ts  # buildConformanceCheck doc comment now points at numericPromotionClass
  - packages/quereus/test/binary-op-static-type.spec.ts  # new describe for plugin-registered numeric operands
  - docs/types-inference.md  # § Binary operator result types: table keyed on operand classes, how a custom type is classified; nullability paragraph says INTEGER-class
----

# Arithmetic promotes a custom numeric type by its physical type

## What changed

`BinaryOpNode.generateType` used to pick an arithmetic result type by comparing operand type **names** with `NUMERIC` and `REAL`. Every other numeric type fell into "both INTEGER", so a REAL-stored plugin type `LENGTH` gave `len * len` → INTEGER while producing 2.25.

Now each operand is classified by `numericPromotionClass` (`types/builtin-types.ts`):

- not `isNumeric` → no class
- name `NUMERIC` → `'NUMERIC'` (by name, the same rule and the same caveat as `buildConformanceCheck`)
- `physicalType` REAL → `'REAL'`; INTEGER → `'INTEGER'`
- any other storage (TEXT, BOOLEAN, OBJECT, NULL) → no class

Both operands having a class → `promoteNumericArithmetic(operator, l, r)` (`planner/nodes/scalar.ts`), the old promotion chain moved into a function and keyed on classes. Otherwise → the existing `ANY` arm. The `bothInteger` nullability exception (`+ - *` keeps operand nullability) is now `leftClass === 'INTEGER' && rightClass === 'INTEGER'`. Because the classifier gates on `isNumeric`, TIMESTAMP (INTEGER-physical, temporal, not numeric) still gets no class, so it stays out of that exception.

Behaviour for the builtin types is unchanged. The only announcement that changes for them is from an `isNumeric` type stored as TEXT/BOOLEAN/OBJECT, which now announces `ANY` instead of falling into the INTEGER branch. No such type exists in the tree.

## Tests added (`test/binary-op-static-type.spec.ts`, describe "arithmetic over plugin-registered numeric types promotes by physical type")

Registers `BOPLEN` (`{ ...REAL_TYPE }` renamed) and `BOPCOUNT` (`{ ...INTEGER_TYPE }` renamed). The spreads make fresh objects, so identity checks against the builtin singletons do not match them. Operands are `cast(… as boplen)` and `cast(… as bopcount)`. Each case asserts the announced type and that the produced value conforms to it (`expectAnnouncedAndInhabited`).

- "a REAL-stored type promotes like REAL": `len + len` → REAL (3), `len * len` → REAL (2.25, the reported wrong answer), `len + 2.5` → REAL (4), `len * 2` → NUMERIC (the mixed REAL/INTEGER pair).
- "an INTEGER-stored type promotes like INTEGER, nullability included": `count + count` → INTEGER (7), `count / count` → NUMERIC (0.75), and `a + b` over two `bopcount not null` columns announces non-nullable. The nullability check uses columns because a converting cast is itself nullable.

No test was added for the TEXT-stored arm (see the gap below).

## Validation

- `yarn workspace @quereus/quereus test`: 11148 passing, 26 pending, 0 failing.
- `yarn workspace @quereus/quereus lint` (eslint plus the test-file type pass): clean.
- I did not re-run the new tests against the old code to watch them fail. By reading the old code: the first REAL-stored assertion announced INTEGER, and BOPCOUNT was not named INTEGER, so the nullability assertion got `true`.

## Known gaps and things for the reviewer

- **The ticket's premise about the runtime was wrong for TEXT-stored numeric types.** The ticket said the runtime coerces such values per row. It does not: `buildNumericOpSpec` dispatches `runNumericOnly` on `isNumeric` alone, so `'1.5' + '2'` concatenates to `'1.52'` and is then nulled, while `*` gives 3. I verified this with a throwaway probe. The `ANY` announcement still holds for both values, so this ticket's claim stands, but the values are wrong. I filed `backlog/bug-arithmetic-over-text-stored-numeric-type-concatenates` with the repro and two candidate fixes (dispatch the runtime on `numericPromotionClass`, or refuse `isNumeric` with non-numeric storage in `registerType`). I did not change the runtime, because the ticket scoped that out and the right contract is a decision.
- The test registers types into the **global** type registry (`types/registry.ts`), so `BOPLEN` and `BOPCOUNT` stay registered for later spec files in the same process. The names are chosen not to collide. Existing specs (for example `KSSNUM` in `optimizer/key-set-seek.spec.ts`) do the same.
- The "NUMERIC by name" match inherits the caveat already documented on `buildConformanceCheck`: a plugin REAL-physical type named `NUMERIC` would be classed NUMERIC. The two sites now cross-reference each other.
- A custom type is still not preserved through arithmetic (`len + len` is REAL, not BOPLEN). That decision belongs to `blocked/feat-custom-numeric-type-survives-arithmetic-and-sums`, which lists this ticket as its prereq.
