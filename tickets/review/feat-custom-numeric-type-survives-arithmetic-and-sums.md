description: A host can now mark its own numeric type (a length, an amount of money) as a quantity, and the type is kept when a query adds, scales or totals such a column, so a report can tell what a computed number measures. Review the rules, the evaluator change and the aggregate binding.
architecture: docs/types-inference.md#binary-operator-result-types
files:
  - packages/quereus/src/types/logical-type.ts  # LogicalType.isQuantity
  - packages/quereus/src/types/builtin-types.ts  # quantityClass, isRealStoredQuantity, quantityArithmeticResult, measurePreservingOperand
  - packages/quereus/src/types/registry.ts  # assertValidQuantityDeclaration, called from TypeRegistry.registerType
  - packages/quereus/src/planner/nodes/scalar.ts  # BinaryOpNode.generateType arithmetic arm
  - packages/quereus/src/runtime/emit/binary.ts  # buildNumericOpSpec: runRealQuantity branch
  - packages/quereus/src/func/builtins/aggregate.ts  # keepQuantityArgType, finalizeSumAsNumber, sum/avg/total
  - packages/quereus/src/types/validation.ts  # buildCellCoercion comment corrected
  - packages/quereus/test/binary-op-static-type.spec.ts  # "arithmetic over quantity types keeps the measure"
  - packages/quereus/test/announced-result-types.spec.ts  # "aggregates > over a quantity type"
  - docs/types-inference.md  # quantity step in § Binary operator result types; sum paragraph; polymorphic list
  - docs/types.md  # isQuantity in § Logical Types; new § Quantity types under Plugin System
----

# A quantity type survives arithmetic and sums — review handoff

## What was built

`LogicalType.isQuantity` (optional boolean). A type that sets it is kept through arithmetic and aggregates that leave its measure unchanged. Notation: `Q` a quantity type, `Q'` a different one, `n` any other numeric-class operand (a custom numeric type without the flag counts as `n`).

- **Registration** (`TypeRegistry.registerType` → `assertValidQuantityDeclaration`): throws `QuereusError` unless `quantityClass(type)` is INTEGER or REAL (so `isNumeric`, INTEGER/REAL `physicalType`, not named NUMERIC) and `isTemporal` is not set. `Database.registerType` rethrows the `QuereusError` as is.
- **Arithmetic** (`quantityArithmeticResult`, called from `BinaryOpNode.generateType` right after `promoteNumericArithmetic`, only in the both-numeric-class arm):
  - Step 1 candidate: `Q + Q`, `Q - Q`, `Q % Q` (same type, by upper-cased name) → `Q`; `Q * n`, `n * Q`, `Q / n`, `Q % n` → `Q`; everything else → none.
  - Step 2: REAL-stored `Q` always stands; INTEGER-stored `Q` stands only when the builtin promotion `P` is INTEGER. Otherwise `P`, as before.
  - Returns the operand's own object (identity matters to the write path and `mergeSetOpColumnType`). Nullability is untouched.
- **Evaluator** (`buildNumericOpSpec`): new first branch `runRealQuantity`, selected by `isRealStoredQuantity(plan.getType().logicalType)`. Computes `inner(Number(v1), Number(v2))`, NULL for NULL operands or a non-finite result. Replaces `mixedBigIntArithmetic` for those expressions. Note `(real-quantity)`.
- **Aggregates** (`aggregate.ts`): `keepQuantityArgType(keptFor, declared)` builds `inferReturnType`:
  - `sum`: keeps `Q` for both stored forms (nullable). Static `returnType` stays NUMERIC.
  - `avg`: keeps REAL-stored `Q` only (nullable); INTEGER-stored → REAL.
  - `total`: keeps REAL-stored `Q` only (not null); INTEGER-stored → REAL not null.
  - `sum.bindArgs`: for a REAL-stored quantity argument, returns `{ finalizeFunction: finalizeSumAsNumber }` (a `bigint` total becomes a `number`); no step, no algebra. The `NOTE:` about rolled-up totals past 2^53 is on that `bindArgs`.

## Decisions made during implement that the ticket did not spell out

- **Evaluator branch placement.** The ticket said "gains one branch"; I put it *before* the temporal branch rather than inside the numeric-only branch. `generateType` announces a REAL-stored quantity only when there is no temporal case and both operands have a numeric class, so checking the announced type first makes the emitter agree with the planner by construction. A contrived plugin type that is temporal *and* numeric-class would otherwise reach the temporal arm (sniffing could return a `bigint`) under a REAL-stored announcement.
- **`quantityClass` treats an unregistered `isQuantity` type as a plain number.** A `LogicalType` object built by hand and never registered (e.g. TEXT-stored with `isQuantity`) never reaches the both-classes arm anyway, and a NUMERIC-named one gets `quantityClass` undefined, so it counts as `n`.
- **`buildCellCoercion` comment** (`types/validation.ts`): besides the REAL→NUMERIC correction, the second example ("an untyped `?` announces TEXT") was also stale (it announces ANY now), so I replaced the pair with current examples and added one sentence pointing at the quantity `validate` obligation.

## By-inspection items (from the ticket's edge-case list)

- **Constant folding**: the only folding pass (`planner/analysis/const-pass.ts` `replaceBorderNodes`) builds the literal with `node.getType()` as the explicit type, so a folded `cast(2 as length) * 3` keeps `Q`. `fold-scalars` named in `planner/analysis/README.md` does not exist in `src/`.
- **`LogicalType` copies**: no site copies named fields. `scalarTypeFromPortable` resolves by name through the registry; `quereus-isolation`'s tombstone column literal is a plain INTEGER. Spreads (`{ ...REAL_TYPE, … }`) carry the flag.
- **Window finalize**: `registerAggregateAsWindowFunction` builds window parts from `bindAggregateSchema(aggSchema, args)`, so frames (sliding included) finalize through `finalizeSumAsNumber`. Side effect: `sum` now has a `bindArgs`, so its window schema rebuilds equivalent parts per call site even for a non-quantity argument (same step/finalize, a fresh `inverse` closure). Harmless; flagging in case a reviewer prefers the window wrapper to return `undefined` when the aggregate bind declines.
- **Materialized views**: existing MV tests pass unedited. An ad-hoc script (not kept) confirmed: `sum` over an INTEGER-stored quantity is delta-maintained through insert and delete with backing column typed as the quantity; `sum`/`avg` over a REAL-stored one match direct evaluation; a coarser `sum(len)` answered from the view announces the quantity and returns a `number` past 2^53; `insert into w select id, len * 2 from s` into a quantity column works.
- **Monotonicity/injectivity** (`isNumericArith`) reads `isNumeric`, unchanged.

## Tests added

- `binary-op-static-type.spec.ts` › "arithmetic over quantity types keeps the measure" (registers BOPQLEN, BOPQMASS REAL-stored and BOPQCENTS INTEGER-stored):
  - table-driven `announces the quantity exactly where the rule keeps it…`: every step 1 row (kept and not kept, including all five operators between `Q` and `Q'`), both step 2 outcomes for INTEGER-stored (`cents * 2` kept; `cents * 1.5`, `cents / 2` not; `cents * cents` → INTEGER); asserts announced type, value conformance, and that a kept type is the registered object.
  - `computes a REAL-stored quantity in floating point, never as a bigint`: `cast(3 as bopqlen) * 9007199254740993` is a `number`; `/ 0` announces nullable `Q` and yields NULL.
  - `keeps + over two NOT NULL INTEGER-stored quantity columns non-nullable`.
  - `refuses a quantity type stored as TEXT`: throws and leaves the name unregistered.
- `announced-result-types.spec.ts` › aggregates › "over a quantity type":
  - `keeps the quantity where its stored form admits the result`: announced type and nullability of `sum`/`avg`/`total` for both stored forms.
  - `finalizes a REAL-stored quantity sum past 2^53 as a number`: rows 9007199254740991 and 2; `sum(len)` and `sum(len) over ()` announce the quantity and return the `number` 9007199254740992.

The existing group "arithmetic over plugin-registered numeric types promotes by physical type" passes unedited (opt-out unchanged).

## Validation run

- `yarn workspace @quereus/quereus lint`: clean (eslint and test type-check).
- `yarn test`: all workspaces pass (engine package 11163 passing, 0 failing).
- The two touched specs also pass under `QUEREUS_REPR_STRICT=1`.
- `yarn test:store` not run.

## Known gaps / things to look at

- Not in scope, documented in `docs/types.md` § Quantity types with workarounds: a quantity mixed with a plain number with no conversion (`coalesce(sum(len), 0)`, `case … else 0`, `union all select 0`) → ANY; products/quotients of quantities → builtin; other functions unchanged; a type that gains the flag after MVs over it were persisted (one sentence in the docs).
- Integer overflow for `Q * n` over an INTEGER-stored quantity follows built-in INTEGER multiplication (`backlog/bug-integer-arithmetic-silently-leaves-the-exact-integer-range`), not addressed.
- The host obligations (plain number is a scale factor; `validate`/`parse` do not run on computed values) are documentation only; the engine cannot check them.
