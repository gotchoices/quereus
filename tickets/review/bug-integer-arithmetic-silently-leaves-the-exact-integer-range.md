---
description: Adding, subtracting or multiplying two ordinary whole numbers used to return a slightly wrong floating-point answer when the true answer passed about nine quadrillion; the engine now notices and redoes that one operation exactly. Needs a review pass.
architecture: docs/types.md#physical-representation
files:
  - packages/quereus/src/runtime/emit/binary.ts        # numberArithmetic (new), buildCoercingArithmeticRun, buildNumericOpSpec (exactCapable / exactInner gate, runNumericOnly)
  - packages/quereus/src/util/numeric-canonical.ts     # isExactIntegerDomain moved here from aggregate.ts
  - packages/quereus/src/func/builtins/aggregate.ts    # now imports isExactIntegerDomain
  - packages/quereus/src/core/statement.ts             # _iterateWithSignal NOTE about this defect removed
  - docs/types.md                                      # births list gains the number-arm widening paragraph; defect sentence dropped from the egress-seam paragraph
  - packages/quereus/test/integer-arithmetic-exact-boundary.spec.ts
repro: verified
---

# Whole-number arithmetic stays exact past the safe-integer range

## What changed

`select 9007199254740991 * 3` returned the double `27021597764222972` (off by one, and a plain `number` where an INTEGER past 2^53 − 1 must be a `bigint`). It now returns `27021597764222973n`. Same for `+`, `-`, text-spelled operands (`'9007199254740991' * 3`), and INTEGER columns.

`runtime/emit/binary.ts`:

- New `numberArithmetic(n1, n2, inner, exactInner)` — the one body for arithmetic over two plain `number`s, used by both per-row arms (`runNumericOnly` and the number arm of `buildCoercingArithmeticRun`). It does the float operation, returns null if non-finite, and — when `exactInner` is given, the float result is not a safe integer, and both operands are safe integers (`isExactIntegerDomain`) — redoes the operation in bigint. The doc comment carries the soundness argument (float result unsafe ⇔ exact result unsafe for `+ - *` over safe integers), which is why the redo needs no narrowing and never fires needlessly.
- `buildNumericOpSpec` decides `exactInner` once at emit: `innerBigInt` for `+ - *` (`exactCapable`) when the announced result type is not REAL-class (`numericPromotionClass(...) !== 'REAL'`), else `undefined`. `/` and `%` never get it (bigint `/` truncates). REAL × REAL is exempt because REAL holds `number` only (R2).
- The coercing arm's `try/catch` around the number arithmetic was dropped: nothing in `numberArithmetic` can throw (documented on the helper), matching the existing no-try/catch reasoning in `runNumericOnly`.
- Small cleanups on lines already being edited: `NumberOp` / `BigIntOp` type aliases for the repeated function types; `runNumericOnly`'s unused `ctx` → `_ctx`; the real-quantity check reuses the hoisted `resultType`.
- `runRealQuantity` and the temporal arms are untouched.

`isExactIntegerDomain` moved from `func/builtins/aggregate.ts` to `util/numeric-canonical.ts` (exported, doc generalized) so `sum()`'s exact accumulator and binary arithmetic share one routing rule.

## Tests

`test/integer-arithmetic-exact-boundary.spec.ts` (new, 3 `it`s). Operands `{0, 1, 2, 3, 2^26, 2^53−2, 2^53−1}` and their negatives, all 169 pairs, operators `+ - *`, stored in a table so the column path is not constant-folded:

- *is exact for two INTEGER operands, literal or column* — the repro literal `9007199254740991 * 3`, then the sweep over INTEGER columns (numeric-only body). Each value is strictly equal to `canonicalizeInteger(exact BigInt answer)` (checks digits and `number`/`bigint` together) and conforms to the announced column type (`conformsToType`).
- *is exact for a TEXT-spelled operand (coercing arithmetic)* — same sweep with the left operand from a TEXT column (coercing body; announced ANY, so the strict-equality check is the one that bites).
- *leaves REAL × REAL a floating-point number past the safe range* — pins the REAL gate: announced REAL, value is the plain double. (Passes before and after the fix; it guards against the gate being removed.)

Confirmed the first two fail before the fix, and that the column sweeps fail on their own (with the literal assertions removed) when the redo is disabled.

## Validation run

- `yarn workspace @quereus/quereus lint` — clean.
- `yarn workspace @quereus/quereus test` — 11181 passing, 23 pending, 0 failing.
- `yarn workspace @quereus/quereus test:repr-strict` — 11191 passing, 13 pending, 0 failing.

## Known gaps / for the reviewer

- Not run: other workspaces' tests and `yarn test:store`. The change is confined to the engine's binary arithmetic body; nothing outside `packages/quereus` was touched.
- Not benchmarked. The in-range path adds one `Number.isSafeInteger(result)` plus an `undefined` check per row on the numeric-only body; the operand checks run only when the result is already unsafe.
- The optional sqllogic lines (`cast(9007199254740991 * 3 as text)`) were not added; the spec covers the behaviour.
- Mixed INTEGER × REAL (announced NUMERIC) now also redoes in bigint when the REAL operand holds a whole value — e.g. `int_col * real_col` over `(9007199254740991, 3.0)` returns `27021597764222973n`. That matches what `mixedBigIntArithmetic` already does for a `bigint` INTEGER against an integral REAL, and NUMERIC admits a `bigint`; flagging it because it is a visible behaviour change for that shape.
- An announced ANY (TEXT / boolean / temporal-fallback operands) gets the redo, since ANY imposes no representation constraint. A plugin type that is REAL-physical but not named NUMERIC is classified REAL by `numericPromotionClass` and so is exempt, consistent with `conformsToType`.
- Unary minus over safe integers cannot leave the range; untouched.
