description: A host can mark its own numeric type (a length, an amount of money) as a quantity, and the type is kept when a query adds, scales or totals such a column, so a report can tell what a computed number measures.
architecture: docs/types-inference.md#binary-operator-result-types
files:
  - packages/quereus/src/types/logical-type.ts  # LogicalType.isQuantity
  - packages/quereus/src/types/builtin-types.ts  # quantityClass, isRealStoredQuantity, quantityArithmeticResult, measurePreservingOperand
  - packages/quereus/src/types/registry.ts  # assertValidQuantityDeclaration, called from TypeRegistry.registerType
  - packages/quereus/src/planner/nodes/scalar.ts  # BinaryOpNode.generateType arithmetic arm
  - packages/quereus/src/runtime/emit/binary.ts  # buildNumericOpSpec: runRealQuantity branch
  - packages/quereus/src/func/builtins/aggregate.ts  # keepQuantityArgType, finalizeSumAsNumber, sum/avg/total
  - packages/quereus/src/func/builtins/builtin-window-functions.ts  # registerAggregateAsWindowFunction bindArgs declines when the aggregate declines
  - packages/quereus/src/types/validation.ts  # buildCellCoercion comment
  - packages/quereus/test/binary-op-static-type.spec.ts  # "arithmetic over quantity types keeps the measure"
  - packages/quereus/test/announced-result-types.spec.ts  # "aggregates > over a quantity type"
  - docs/types-inference.md
  - docs/types.md  # § Quantity types
----

# A quantity type survives arithmetic and sums

## What landed

`LogicalType.isQuantity` (optional). A type that sets it is kept through arithmetic and aggregates that leave its measure unchanged (`Q` a quantity type, `n` any other numeric-class operand):

- **Registration** refuses `isQuantity` unless the type is numeric, stored as INTEGER or REAL, not named NUMERIC, and not temporal (`assertValidQuantityDeclaration`).
- **Arithmetic** (`quantityArithmeticResult`, from `BinaryOpNode.generateType`): `Q ± Q`, `Q % Q`, `Q * n`, `n * Q`, `Q / n`, `Q % n` keep `Q`; an INTEGER-stored `Q` is kept only where the builtin promotion is INTEGER. Everything else announces the builtin promotion as before. The kept type is the operand's own object.
- **Evaluator**: an expression announced as a REAL-stored quantity is computed in floating point (`runRealQuantity`), never returning a `bigint`.
- **Aggregates**: `sum` keeps `Q` for both stored forms (and binds a finalize that turns a `bigint` total into a `number` for REAL-stored); `avg` and `total` keep REAL-stored `Q` only. Static `returnType`s are unchanged, so the materialized-view delta gate is unaffected.

Rules and host obligations are in docs/types-inference.md § Binary operator result types and docs/types.md § Quantity types.

## Review findings

Read the `ticket(implement): feat-custom-numeric-type-survives-arithmetic-and-sums` diff first, then the surrounding planner, emitter, aggregate binding, window registration, materialized-view plan builders and rollup rewrite.

**Checked, no defect found:**

- *Planner/evaluator agreement*: the evaluator branch is selected by the announced type, so the two cannot diverge. Nullability: every arithmetic shape that can reach the REAL-stored quantity branch is already announced nullable (only `+ - *` over two INTEGER-class operands are not, and those never select that branch), so the branch's null-for-non-finite result is covered.
- *Unary `-len`/`+len`*: `UnaryOpNode` already keeps a numeric operand's type; confirmed it announces the quantity.
- *Aggregate binding everywhere it runs*: grouped aggregates (`bindAggregateSchemas`), windows (`registerAggregateAsWindowFunction`), materialized-view maintenance (`database-materialized-views-plan-builders.ts`; a REAL-stored sum fails the exact-domain gate and is residual, an INTEGER-stored one is delta-maintained and may hold a `bigint`, which INTEGER admits) and rollup (`rule-materialized-view-rewrite.ts` binds against the backing column type, which is the quantity, so it picks up `finalizeSumAsNumber`).
- *Registration paths*: `Database.registerType` is the only public entry and goes through `TypeRegistry.registerType`; builtin registrations pass the new check trivially.
- *Ad-hoc probe* (not kept): `union all` of `len * 2` and `len`, `coalesce(len * 2, len)`, `-len`, folded `cast(2 as len) * 3`, `sum` over an empty set, sliding-frame `sum` over REAL- and INTEGER-stored quantities past 2^53, `avg` window, `sum(distinct len)`, `max(len * 2)`, `len * r`, `c * r`, `len + c`, and `insert into w select id, len * 2 from t` all announced and produced what the rules say, with REAL-stored results always `number`.
- *Docs*: docs/types-inference.md and docs/types.md describe the shipped rules; the stale pointer to the implement ticket in docs/types-inference.md was removed by the implementer; no other doc references the ticket. The `buildCellCoercion` comment matches current behavior.
- *Tests*: the implementer's table-driven rule test and aggregate announcement/finalize tests pin named rows of the specification with real branching; the registration-refusal test pins the one error path. Kept all; none restate the implementation or test a mock. No test added: the review found no new defect.

**Fixed inline (minor):**

- `registerAggregateAsWindowFunction`'s `bindArgs` rebuilt equivalent window parts (with a fresh `inverse` closure) for every call site of a window `sum` once `sum` gained a `bindArgs`, even when the aggregate declined. It now returns `undefined` when `bindAggregateSchema` returns the schema unchanged, matching the "a hook that declines keeps the declared defaults" contract.
- `quantityClass`'s doc comment claimed it treats an unregistered flagged type as a plain number; it does not check registration, only the stored form. Reworded to say what it checks.

**Noticed, not acted on (no ticket):**

- *Index seeks*: `isSeekKeySpaceNumeric` admits only the builtin INTEGER/REAL/NUMERIC singletons, so `real_col = len * 2` no longer qualifies for a cross-type seek (it announced REAL before), while `len_col = len * 2` now does (identical types). This is the existing, documented rule for plugin types (a `len` column already behaved this way); correctness is unaffected, only the access path. No tripwire added: the existing doc comment on `isSeekKeySpaceNumeric` already explains why plugin types stay out.
- *Accepted limits* already documented by the implementer in docs/types.md § Quantity types (mixed quantity/plain-number branches announce ANY, products of quantities fall back, INTEGER-stored fractions fall back, a view persisted before the flag keeps a NUMERIC backing column) and the `NOTE:` on `sum.bindArgs` about rolled-up totals past 2^53. Left as is.
- *Integer overflow* for `cents * n` follows builtin INTEGER multiplication; already tracked by `backlog/bug-integer-arithmetic-silently-leaves-the-exact-integer-range`.

**Empty categories:** resource cleanup — nothing allocated; error handling — the one new error (registration refusal) is a `QuereusError` rethrown unchanged by `Database.registerType`; performance — the planner check runs once per node and the evaluator branch is per-row arithmetic no heavier than the numeric fast path.

## Validation

- `yarn workspace @quereus/quereus lint`: clean.
- `yarn test`: all workspaces pass (engine package 11163 passing).
- `yarn test:store` not run (no store-specific code touched).
