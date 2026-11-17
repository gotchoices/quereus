---
description: Adding, subtracting or multiplying two ordinary whole numbers used to return a slightly wrong floating-point answer when the true answer passed about nine quadrillion; the engine now notices and redoes that one operation exactly.
architecture: docs/types.md#physical-representation
files:
  - packages/quereus/src/runtime/emit/binary.ts        # numberArithmetic, buildCoercingArithmeticRun, buildNumericOpSpec (exactInner gate)
  - packages/quereus/src/util/numeric-canonical.ts     # isExactIntegerDomain (moved from aggregate.ts)
  - packages/quereus/src/func/builtins/aggregate.ts    # imports isExactIntegerDomain
  - packages/quereus/src/core/statement.ts             # stale NOTE about this defect removed
  - docs/types.md                                      # births list: number-arm widening paragraph
  - docs/usage-types.md                                # user-facing example (added in review)
  - packages/quereus/test/integer-arithmetic-exact-boundary.spec.ts
repro: verified
---

# Whole-number arithmetic stays exact past the safe-integer range

## What landed

`select 9007199254740991 * 3` used to return the double `27021597764222972` (off by one, and a `number` where an INTEGER past 2^53 − 1 must be a `bigint`). It now returns `27021597764222973n`. Same for `+` and `-`, text-spelled operands, INTEGER columns, ANY-typed parameters, and mixed INTEGER × REAL (announced NUMERIC) when the REAL side holds a whole value.

- `numberArithmetic` (`runtime/emit/binary.ts`) is the one body for arithmetic over two plain `number`s, shared by the numeric-only and coercing per-row arms. After the float operation it redoes the operation in bigint when an `exactInner` was supplied, the float result is not a safe integer, and both operands are safe integers. For `+ - *` over safe integers the float result is unsafe exactly when the exact one is, so the redo never fires needlessly and needs no narrowing.
- `buildNumericOpSpec` supplies `exactInner` at emit time only for `+ - *` and only when the announced result type is not REAL-class (`numericPromotionClass(...) !== 'REAL'`). REAL × REAL stays a double, since REAL holds `number` only.
- `isExactIntegerDomain` moved to `util/numeric-canonical.ts` so `sum()` and binary arithmetic share one routing rule.

Commit: `ticket(implement): bug-integer-arithmetic-silently-leaves-the-exact-integer-range`.

## Review findings

**Checked**

- *Soundness argument* in the `numberArithmetic` doc comment: correct. Exact answers inside ±(2^53 − 1) are representable so the float equals them; exact answers outside round monotonically to a double whose magnitude is ≥ 2^53, which `Number.isSafeInteger` rejects. Safe × safe is below 2^106, so the float never overflows to Infinity and the INTEGER-class non-nullability claim in `BinaryOpNode.generateType` (`planner/nodes/scalar.ts`) still holds.
- *Gate vs. announced type*: every type `generateType` can announce for a body that reaches `numberArithmetic` was traced. Temporal result types are announced only for the specialized temporal arm, which never calls it; the temporal fallback and generic arms announce ANY or a numeric class; REAL-stored quantities take `runRealQuantity`. The gate (`numericPromotionClass !== 'REAL'`) agrees with `buildConformanceCheck` (`types/representation.ts`): INTEGER, NUMERIC and ANY admit `bigint`.
- *Removed try/catch* in the coercing arm: safe. Number arithmetic cannot throw, and `BigInt()` of a safe integer cannot throw.
- *`/` and `%` excluded*: correct. Neither can leave the safe range from safe-integer operands, and bigint `/` truncates.
- *Edge values, probed with a throwaway spec (deleted)*: `-9007199254740991 - 1` → `-9007199254740992n`; `9007199254740991 + 1 - 1` → `9007199254740991` (`number`, narrowed by the existing bigint arm); `? * ?` bound to `(9007199254740991, 3)` → bigint (announced ANY); `* 3.5` → double (NUMERIC); `i*r`, `i*n`, `i*x`, `x*i` columns → bigint; `r*r` → `number` (REAL); `sum(i * 3)` → bigint; `(i * 3) / 3` and `% 7` → correct values. `-0` stays `-0` (it is a safe integer, so it takes the unchanged path).
- *Docs*: `docs/types.md` births list updated and the stale defect sentence in the egress-seam paragraph removed by the implementer. Grepped docs and source for other references to the defect: none remain outside archived `complete/` tickets and `.garden-report.md`, which are historical.
- *Tests*: the new spec's three cases each meet the bar. Two reproduce the defect through the two distinct runtime bodies (numeric-only and coercing), and one pins the REAL exemption, which has real branching. Nothing cut.
- *Lint and tests*: `yarn workspace @quereus/quereus lint` passed (exit 0). `yarn workspace @quereus/quereus test` reported 11181 passing, 23 pending, 0 failing.

**Found and fixed (minor)**

- The user-facing large-integers section (`docs/usage-types.md`) said nothing about arithmetic. Added a one-line example showing `9007199254740991 * 3` widening to a `bigint`.

**Observed, no action**

- Literals such as `3.0` and `1e15` are announced INTEGER, because a literal's type is inferred from its JS value, which cannot tell `3.0` from `3`. So `9007199254740991 * 3.0` and `1e15 * 1e15` now return exact `bigint`s. Before this fix they returned a double past 2^53 under an announced INTEGER, which broke the representation rule. This is existing literal-typing design (R1), not something this change introduced, and the fix makes those results conform. No ticket.
- Performance: integer-valued rows pay one extra `Number.isSafeInteger` call. Fractional results under a NUMERIC or ANY announcement pay that call plus an operand check, which short-circuits on the first fractional operand. Not measured. It is the same order as the existing finite check, so no tripwire was added.

**Major / tickets filed**: none. Nothing found that needed a ticket.

**Tripwires**: none added. The one plausible condition, a plugin REAL-physical type named `NUMERIC`, already has a `NOTE:` on `buildConformanceCheck`, and this gate inherits that behaviour through `numericPromotionClass`.

**Not run**: `yarn test:store`, `test:repr-strict` (the implementer ran repr-strict with 0 failing), and other workspaces. The change is confined to the engine's in-memory arithmetic body and does not touch storage.
