description: A host that declares a column with its own numeric type, such as a length or an amount of money, loses that type as soon as a query adds, scales or totals the column, so reports cannot tell what a computed number measures. Someone needs to decide whether, and how, a custom type should carry through arithmetic and sums.
prereq: arithmetic-promotes-custom-numeric-types-by-physical-type
architecture: docs/types-inference.md#binary-operator-result-types
files:
  - packages/quereus/src/types/logical-type.ts  # LogicalType: a new opt-in field would go beside isNumeric
  - packages/quereus/src/planner/nodes/scalar.ts  # BinaryOpNode.generateType, arithmetic arm
  - packages/quereus/src/func/builtins/aggregate.ts  # sum (NUMERIC_RETURN), avg (REAL_RETURN), total (REAL_RETURN_NOT_NULL); min/max already infer from the argument
  - packages/quereus/src/types/representation.ts  # buildConformanceCheck: a REAL-physical type admits only `number`
  - docs/types.md  # § Logical Types, § Plugin System
  - docs/types-inference.md  # § Binary operator result types
----

# Should a custom numeric type survive arithmetic and sums?

**Blocked: the specification is silent.** This is unblocked when a human accepts or edits the proposed rules below, in particular whether it is opt-in and how a result that does not fit the custom type's stored form is handled.

## Background

SiteCAD (Nate, 2026-11-13) wants a column to say what its numbers measure (length, area, volume) so that every surface can show it in the reader's units. Registering a custom type per measure was the first idea. Today a custom numeric type is kept by a plain select, `-x`, `abs`, `round`, `min`, `max`, `coalesce`, `case`, subqueries, common table expressions and `union all`. It is dropped by every arithmetic operator and by `sum`, `avg` and `total`. A report is mostly totals and differences, so the type is gone before it is useful. SiteCAD chose a different carrier for stored tables for this reason (`tickets/blocked/decide-how-a-stored-table-column-declares-its-measure.md` in that repository). Whether the type route becomes usable depends on this decision.

The separate wrong answer, where `len + len` announced INTEGER for a fractional value, is fixed by the prereq. After it lands, `len + len` announces REAL. That is true, but it is not LENGTH.

## Proposed rules (recommended default)

A type opts in with a new optional `LogicalType` field. A working name is `quantity: true`, meaning "values are amounts of one measure". It is only meaningful together with `isNumeric`. For a quantity type `Q` and a built-in numeric operand `n`:

| Expression | Result |
|---|---|
| `Q + Q`, `Q - Q` (same type) | `Q` |
| `Q * n`, `n * Q`, `Q / n`, `Q % n` | `Q` |
| `-Q`, `abs(Q)`, `round(Q, k)`, `min(Q)`, `max(Q)` | `Q` (already true) |
| `sum(Q)`, `avg(Q)`, `total(Q)` | `Q` |
| `Q * Q`, `Q / Q`, `Q1 * Q2`, `Q1 / Q2` | the built-in promotion of their stored forms (a length times a length is not a length; a ratio has no unit) |
| `Q + n`, `Q1 + Q2` (different quantities) | the built-in promotion (an untyped number added to a length could be anything) |

Every other built-in function keeps its current return type.

**Fitting the result into `Q`'s stored form.** This is the part that needs a decision. The R2 representation rule (`docs/types.md` § Physical representation) says a value announced as a REAL-physical type is a JS `number`. The built-in promotion announces NUMERIC (which admits `bigint`) in exactly the cases above where `Q` would be returned: `Q * n` with an INTEGER `n`, because `mixedBigIntArithmetic` keeps a `bigint` operand exact against an integral REAL value, and `sum`, because it accumulates integral rows exactly and can finish as a `bigint` past 2^53. The recommendation is that when the announced result is a REAL-physical quantity, the operator or aggregate converts a `bigint` result to `number` before returning it. This is the same rounding a REAL column applies on write, and a measured quantity never needs integer exactness past 2^53. For an INTEGER-physical quantity (money in cents), the operations that can produce a fraction (`Q / n`, `avg(Q)`, `total(Q)`) return the built-in promotion instead of `Q`. The others stay integral.

## Alternatives considered

- **Default for every `isNumeric` custom type, no new field.** Rejected. An identifier-like numeric type (an order number, an encoded key) does not want `id * 2` to remain an identifier. It would also silently change announced types for hosts that already register numeric types.
- **Only preserve when the built-in promotion already fits the stored form (no conversion).** Rejected. `len * 2` (the most common scaling) and `sum(len)` would both fall back to NUMERIC, which defeats the purpose.
- **A unit algebra (a type declares that `LENGTH * LENGTH` is `AREA`).** Not rejected, only deferred. It is additive on top of the table above (the `Q1 * Q2` row would consult a declared product before falling back), and SiteCAD has not asked for it.

## If nothing is done

Custom numeric types stay usable for storage, validation and ordering but carry no meaning into computed columns. Hosts that need it keep a measure annotation outside the type system, which is what SiteCAD is doing now.

## Reversibility

The field is opt-in and additive, so no existing type changes behaviour, and removing it later only affects types that set it. The `bigint` → `number` conversion is the one behaviour change inside the runtime, and it applies only to results announced as an opted-in REAL-physical quantity.
