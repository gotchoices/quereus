description: A host can declare a column with its own numeric type, such as a length or an amount of money, but the type is lost as soon as a query adds, scales or totals the column, so a report cannot tell what a computed number measures. Let a type opt in to being kept through the operations that leave its measure unchanged.
architecture: docs/types-inference.md#binary-operator-result-types
files:
  - packages/quereus/src/types/logical-type.ts  # LogicalType: add isQuantity beside isNumeric
  - packages/quereus/src/types/builtin-types.ts  # numericPromotionClass; home for the quantity predicate and the arithmetic rule
  - packages/quereus/src/types/registry.ts  # TypeRegistry.registerType: reject an invalid isQuantity declaration
  - packages/quereus/src/planner/nodes/scalar.ts  # BinaryOpNode.generateType arithmetic arm, promoteNumericArithmetic
  - packages/quereus/src/runtime/emit/binary.ts  # buildNumericOpSpec: floating-point body for a REAL-stored quantity result
  - packages/quereus/src/func/builtins/aggregate.ts  # sum, avg, total: inferReturnType; sum: bindArgs
  - packages/quereus/src/func/builtins/return-types.ts  # scalarReturn()
  - packages/quereus/test/binary-op-static-type.spec.ts  # expectAnnouncedAndInhabited; existing plugin-type group
  - packages/quereus/test/announced-result-types.spec.ts  # existing sum() announcement tests
  - docs/types-inference.md  # § Binary operator result types, § Omitting the return type (the sum paragraph), § Built-in Polymorphic Functions
  - docs/types.md  # § Logical Types, § Plugin System
difficulty: medium
----

# A quantity type survives arithmetic and sums

## Decision

Accepted on 2026-11-14 (Nate delegated the call), with the corrections listed under *Changes from the blocked proposal*. The earlier ticket `arithmetic-promotes-custom-numeric-types-by-physical-type` has landed, so `len + len` over a REAL-stored custom type already announces REAL. This ticket makes it announce the custom type itself when the type has opted in.

## Background

SiteCAD wants a column to say what its numbers measure (length, area, volume) so every surface can show the value in the reader's units. One registered type per measure does that for stored columns. Today such a type is kept by a plain select, `-x`, `abs`, `round`, `min`, `max`, `coalesce`, `case`, subqueries, common table expressions and `union all` between identical types. Every arithmetic operator and `sum`, `avg` and `total` drop it. A report is mostly totals and differences, so the type is gone before it is useful.

## The opt-in

Add one optional field to `LogicalType`:

```typescript
/**
 * Values are amounts of one measure (a length, a mass, an amount of money). Opts the
 * type in to being kept through arithmetic and aggregates that leave the measure
 * unchanged. Requires isNumeric and a physicalType of INTEGER or REAL.
 */
isQuantity?: boolean;
```

Below, `Q` is a type with `isQuantity`, `Q'` is a different such type, and `n` is any operand that has a numeric promotion class (`numericPromotionClass` returns a value) and is not a quantity. A custom numeric type without the flag, such as an order number, counts as `n`.

Registration refuses a type that sets `isQuantity` unless `numericPromotionClass(type)` is `'INTEGER'` or `'REAL'` and `isTemporal` is not set. Put the check in `TypeRegistry.registerType` (`types/registry.ts`), which both `Database.registerType` and plugin loading reach, and throw a `QuereusError`. This keeps a quantity stored as TEXT, or one named `NUMERIC`, from existing at all, so no later code has to handle it.

## What a host agrees to by setting the flag

Both points go in `docs/types.md` § Plugin System, because the engine cannot check either.

- **A plain number is a pure scale factor.** `len * 2` is a length, and so is `len * qty` where `qty` is a count. The engine cannot tell a count from a rate, so `len * unit_price` also announces the length type when `unit_price` is a plain REAL column, although the value is money. A host that keeps rates or money in the same tables declares those columns with their own quantity types. Two different quantities multiplied or divided announce the built-in type, which is the correct "no known measure" answer.
- **`validate` and `parse` do not run on a computed value.** A value announced as `Q` and written into a `Q` column is trusted (`buildCellCoercion` in `types/validation.ts` skips conversion when the source and target types are the same object, and only checks the JavaScript form). `Q - Q` can be negative and `Q / n` can have any number of decimals, so a quantity type must not use `validate` or `parse` to restrict range or precision. Those restrictions belong in CHECK constraints, as the same doc section already says for precision.

## Arithmetic rules

`BinaryOpNode.generateType` decides in two steps, after the temporal case and only when both operands have a numeric promotion class.

**Step 1: does the operation keep the measure?**

| Expression | Candidate |
|---|---|
| `Q + Q`, `Q - Q`, `Q % Q` (same type on both sides) | `Q` |
| `Q * n`, `n * Q`, `Q / n`, `Q % n` | `Q` |
| anything else: `Q * Q`, `Q / Q`, `n / Q`, `n % Q`, `Q + n`, `n - Q`, and every operator between `Q` and `Q'` | none |

**Step 2: does the result fit the stored form of `Q`?** Let `P` be the built-in type `promoteNumericArithmetic` returns for the two operand classes today.

- `Q` stored as REAL: the candidate always stands. `P` is REAL or NUMERIC, and the evaluator computes the result in floating point (see *Evaluator*), so the value is always a JavaScript `number`.
- `Q` stored as INTEGER: the candidate stands only when `P` is INTEGER. So `Q + Q`, `Q - Q`, `Q % Q`, and `Q * n` and `Q % n` with an INTEGER-class `n` keep `Q`. `Q / n`, and anything with a REAL or NUMERIC `n`, can produce a fraction and announce `P`.

When there is no candidate, or the candidate does not stand, the announcement is `P`, exactly as today. The engine never raises an error for a combination that makes no sense as a measure. It only falls back to the built-in type.

Nullability is computed as it is now and does not depend on the quantity rule. An INTEGER-stored `Q` is INTEGER-class, so `a + b` over two NOT NULL `Q` columns stays non-nullable, which the lens prover relies on.

**Same type** is decided by name (`left.name.toUpperCase() === right.name.toUpperCase()`), not by object identity. The comment in `generateType` explains why: a schema read back from persistence can hold a second `LogicalType` object for the same type. **The announced type is the left operand's own object** (or the quantity operand's, for `n * Q`), never a copy, because the write path and `mergeSetOpColumnType` compare types by identity.

### Where the rule lives

Write the two steps as one pure function next to `numericPromotionClass` in `types/builtin-types.ts`, for example `quantityArithmeticResult(operator, leftType, rightType, promoted): LogicalType | undefined`, and call it from `generateType` right after `promoteNumericArithmetic`. One function keeps `generateType` short and gives a later declared-product rule (a type saying `LENGTH * LENGTH` is `AREA`) a single place to be consulted in step 1.

### Evaluator

`buildNumericOpSpec` (`runtime/emit/binary.ts`) gains one branch, selected by the announced result type (`plan.getType().logicalType`, the same value `generateType` produced, so the two cannot disagree). When that type is a REAL-stored quantity:

```typescript
run = function runRealQuantity(_ctx, v1, v2) {
	if (v1 === null || v2 === null) return null;
	const result = inner(Number(v1), Number(v2));
	return Number.isFinite(result) ? result : null;
};
```

Both operands are `number | bigint` here, because both have a numeric promotion class. This replaces `mixedBigIntArithmetic` for these expressions on purpose. That function keeps a `bigint` operand exact when the other side holds a whole number, which returns a `bigint` (not admissible in a REAL-stored type) and makes `/` truncate (`7.0 / 2n` gives 3). A measured quantity wants neither. An INTEGER-stored quantity result needs no new branch: its values are the ones built-in INTEGER arithmetic already produces.

## Aggregate rules

| Call | `Q` stored as REAL | `Q` stored as INTEGER |
|---|---|---|
| `sum(Q)` | `Q`, nullable | `Q`, nullable |
| `avg(Q)` | `Q`, nullable | REAL, as today (an average of whole cents is not whole) |
| `total(Q)` | `Q`, not null | REAL not null, as today (`total` always adds in floating point) |
| `min(Q)`, `max(Q)` | `Q` already | `Q` already |

Mechanism, all in `func/builtins/aggregate.ts`:

- `sum`, `avg` and `total` each gain an `inferReturnType` that returns `scalarReturn(argType, nullable)` for the cells above and the current constant (`NUMERIC_RETURN`, `REAL_RETURN`, `REAL_RETURN_NOT_NULL`) otherwise. Keep the static `returnType` field as it is: `core/database-materialized-views-plan-builders.ts` reads it to decide whether a sum can be maintained incrementally, and that decision must not change.
- `sum` gains a `bindArgs` hook, the per-call-site specialization `min` and `max` already use. When the argument's type is a REAL-stored quantity it returns `{ finalizeFunction }` only, wrapping `finalizeSum` so a `bigint` total becomes a `number`. `sum` returns a `bigint` when every row was a whole number and the total passed 2^53, which a REAL-stored type does not admit. Return no `stepFunction` and no `algebra`, so `bindAggregateSchema` keeps the declared ones.
- `avg` and `total` always return a `number`, so they need no runtime change.

`bindArgs` is already applied at every place an aggregate runs: the stream and hash aggregate emitters (`runtime/emit/aggregate-setup.ts`), window functions (`registerAggregateAsWindowFunction` copies both `inferReturnType` and `bindArgs` from the aggregate schema), incremental materialized-view maintenance, and the rewrite that answers a query from a materialized view. No emitter needs editing.

## Changes from the blocked proposal

- The proposal kept `Q` for `Q * n` and `Q % n` regardless of `n`. For an INTEGER-stored quantity and a fractional `n` that would announce an integer type over a fractional value. Step 2 closes this.
- The proposal converted a `bigint` result to `number` after the fact. For arithmetic this ticket computes in floating point instead, which also avoids the truncating division described under *Evaluator*.
- `Q % Q` is added (a remainder has the unit of the dividend). `n / Q` and `n % Q` are named as falling back.
- The field is named `isQuantity` to match `isNumeric`, `isTextual` and `isTemporal`.
- Registration rejects an invalid declaration.
- The two host obligations are stated.

## Not in scope

Each of these announces what it announces today. The docs name them with the workaround, so a host is not surprised.

- **A quantity mixed with a plain number where no conversion happens**: `coalesce(sum(len), 0)`, `case when c then len else 0 end`, `select len from a union all select 0`. `mergeSetOpColumnType` sends the pair to ANY because neither branch is converted. Workarounds: `total(len)` for the empty-group zero, or `cast(0 as length)`.
- **Products and quotients of quantities** (`width * height` as an area). The result is the built-in type. Workaround: `cast(width * height as area)`. A declared product rule is deferred until a host asks.
- **Other functions.** `sqrt`, `floor`, `ceil`, the statistical aggregates and the rest keep their current return types.
- **`bug-arithmetic-over-text-stored-numeric-type-concatenates`** (backlog). The registration check here covers only types that set `isQuantity`. Whether `isNumeric` alone should require INTEGER or REAL storage stays with that ticket.

## Edge cases & interactions

- **A type without the flag is unchanged.** The existing group "arithmetic over plugin-registered numeric types promotes by physical type" in `test/binary-op-static-type.spec.ts` registers types without `isQuantity` and must pass unedited.
- **An operand with no numeric class** (an untyped parameter, a NULL literal, text, a boolean) still announces ANY, because the quantity rule runs only inside the both-classes arm. By inspection.
- **Temporal operands.** The temporal case is evaluated first and returns before the quantity rule. Registration forbids `isQuantity` with `isTemporal`. By inspection.
- **Non-finite results.** A REAL-stored quantity result is nullable, and the new evaluator body returns NULL for a non-finite result, including a `bigint` operand too large for a double. Covered by the announced nullability already being true; one test case with `/ 0`.
- **`sum` past 2^53 over whole-valued rows in a REAL-stored quantity column.** The bound finalize returns a `number`. This is the one aggregate value test (below).
- **A sliding window frame.** When the last fractional value leaves a frame, `sum` goes back to its exact part and can finalize a `bigint`. The bound finalize covers it because the window registration takes its finalize from the bound aggregate schema. By inspection of `aggregateWindowParts`; no separate test.
- **Incremental materialized-view maintenance.** `sum` over an INTEGER-stored quantity stays incrementally maintained (the gate reads the argument column's stored form), and its backing column is now declared `Q` instead of NUMERIC. `sum` over a REAL-stored quantity stays fully recomputed, as every REAL sum does. Verify by running the existing materialized-view tests; add none.
- **Answering a coarser `sum(len)` from a materialized view of finer sums.** The partial sums stored in a REAL-stored quantity column have already been converted to `number`, so above 2^53 the rolled-up total can differ from a direct sum in the last digits. Leave a `NOTE:` at the `bindArgs` site saying so; it only matters for a quantity whose totals exceed 9e15 in its stored unit.
- **A type that gains the flag after materialized views over it were persisted.** The stored backing column is NUMERIC while the recomputed plan announces `Q`. Not handled (the project does not yet keep backwards compatibility). One sentence in the docs: set the flag before creating views over the type.
- **Integer overflow on the number path.** `Q * n` over an INTEGER-stored quantity inherits whatever built-in INTEGER multiplication does past the safe range. That is `backlog/bug-integer-arithmetic-silently-leaves-the-exact-integer-range`; do not address it here.
- **Constant folding.** `cast(2 as length) * 3` folds to a literal. Check by reading the folding pass that the literal keeps the folded node's announced type. If it re-infers the type from the value, the fold drops `Q`; fix it there or report it in the handoff.
- **Copies of a `LogicalType`.** Search for code that builds a `LogicalType` field by field (schema persistence, portable type serialization such as `scalarTypeFromPortable`). A site that resolves by name through the registry is fine. A site that copies named fields would drop `isQuantity`.
- **Monotonicity and injectivity** (`BinaryOpNode.isNumericArith`) read the operands' `isNumeric`, which is unchanged. By inspection.

## Tests

- `test/binary-op-static-type.spec.ts`: one table-driven test over the arithmetic rules, using `expectAnnouncedAndInhabited` (announced type plus the value conforming to it). Register a REAL-stored quantity, an INTEGER-stored quantity and a second REAL-stored quantity for the `Q` with `Q'` rows. Cover each row of the step 1 table, both step 2 outcomes for the INTEGER-stored type (`cents * 2` keeps it, `cents * 1.5` and `cents / 2` do not), and `cast(3 as <real quantity>) * 9007199254740993` announcing the quantity and returning a `number`. Add one assertion that `a + b` over two NOT NULL INTEGER-stored quantity columns is non-nullable.
- `test/announced-result-types.spec.ts`: the aggregate table (announced type of `sum`, `avg`, `total` for each stored form), and one value case: a REAL-stored quantity column holding 9007199254740991 and 2, where `sum(v)` and `sum(v) over ()` both announce the quantity and return a `number`.
- One assertion that registering a TEXT-stored type with `isQuantity` throws.

No other tests. The opt-out behaviour is already covered by the existing tests passing unedited.

## Docs

- `docs/types-inference.md` § Binary operator result types: replace the sentence that says the result is always a built-in type and points at this ticket with the two-step rule and its table. In § Omitting the return type, the paragraph saying `sum()` does not narrow to its argument's type gains the quantity exception and how the bound finalize keeps it sound. In § Built-in Polymorphic Functions, add `sum`, `avg` and `total` to the aggregate line.
- `docs/types.md` § Logical Types: add `isQuantity` to the interface listing. § Plugin System: a short "Quantity types" subsection with a registration example, the two host obligations, the fallbacks under *Not in scope* with their workarounds, and the note about setting the flag before creating views.
- `packages/quereus/src/types/validation.ts`: the `buildCellCoercion` comment says `sum()` announces REAL. It announces NUMERIC. Correct it while in the area.

## TODO

Phase 1: the flag and arithmetic
- Add `isQuantity` to `LogicalType` with the doc comment above
- Reject an invalid `isQuantity` declaration in `TypeRegistry.registerType`
- Add the quantity predicate and `quantityArithmeticResult` beside `numericPromotionClass`
- Call it from `BinaryOpNode.generateType` after `promoteNumericArithmetic`
- Add the floating-point branch to `buildNumericOpSpec`, selected by the announced result type
- Arithmetic tests

Phase 2: aggregates
- `inferReturnType` on `sum`, `avg` and `total`
- `bindArgs` on `sum` with the `bigint` to `number` finalize, and the `NOTE:` about rolled-up totals
- Aggregate tests and the registration assertion
- Work through the by-inspection items under *Edge cases & interactions* (constant folding, `LogicalType` copies, window finalize)

Phase 3: docs and validation
- Update `docs/types-inference.md` and `docs/types.md` as listed
- Correct the `buildCellCoercion` comment
- `yarn workspace @quereus/quereus lint` and `yarn test`
