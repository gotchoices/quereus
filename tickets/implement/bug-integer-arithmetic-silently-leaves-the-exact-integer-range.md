---
description: Adding, subtracting or multiplying two ordinary whole numbers returns a slightly wrong floating-point answer when the true answer is bigger than about nine quadrillion; make the engine notice and redo that one operation exactly.
architecture: docs/types.md#physical-representation
files:
  - packages/quereus/src/runtime/emit/binary.ts        # buildNumericOpSpec (runNumericOnly arm) + buildCoercingArithmeticRun (number arm) — the two unchecked sites
  - packages/quereus/src/util/numeric-canonical.ts     # canonicalizeInteger / the R1 contract
  - packages/quereus/src/func/builtins/aggregate.ts    # addWithPromotion — the same soundness argument, already applied for sum()
  - packages/quereus/src/planner/nodes/scalar.ts       # promoteNumericArithmetic — which announced types admit a bigint
  - packages/quereus/src/core/statement.ts             # _iterateWithSignal NOTE (~line 655) to delete once fixed
  - docs/types.md                                      # ~line 222 paragraph naming this defect, to update
  - packages/quereus/test/logic/03.7-bigint-mixed-arithmetic.sqllogic
difficulty: medium
repro: verified
---

# Whole-number arithmetic silently falls out of the exact range

## Reproduction (verified 2026-11-16, built `dist`, plain in-memory `Database`)

| SQL | returned | JS type | announced | exact answer |
|---|---|---|---|---|
| `select 9007199254740991 * 3` | 27021597764222972 | number | INTEGER | 27021597764222973 |
| `select 9007199254740991 + 9007199254740991` | 18014398509481982 | number | INTEGER | same digits, but must be a `bigint` |
| `select -9007199254740991 - 2` | -9007199254740992 | number | INTEGER | -9007199254740993 |
| `select 100000000000 * 100000000000` | 1e+22 | number | INTEGER | 10^22 as `bigint` |
| `select '9007199254740991' * 3` | 27021597764222972 | number | ANY | 27021597764222973 |
| `select 9007199254740991 * 3 = 27021597764222973` | false | boolean | BOOLEAN | true |

Every row either has the wrong digits, or has the right digits in a plain floating-point `number` past 2^53 − 1, which breaks the representation rule (R1/R2 in `util/numeric-canonical.ts`, docs/types.md § Physical representation): an INTEGER value past the safe range must be a `bigint`.

## Root cause

`runtime/emit/binary.ts` has two per-row bodies that do arithmetic on two plain JS `number`s and return the result without asking whether it left the safe-integer range:

- `runNumericOnly` inside `buildNumericOpSpec` (the `numeric-fast` note) — taken whenever both operands are declared numeric. **This is the main site**; integer literals and INTEGER columns land here. The original ticket only named the second site.
- the `else` arm of `buildCoercingArithmeticRun` (the `numeric` / `temporal` fallback notes) — taken for TEXT/ANY operands after `coerceToNumberForArithmetic`, e.g. `'9007199254740991' * 3`.

Both only re-enter exact arithmetic (`mixedBigIntArithmetic`) when an *input* is already a `bigint`.

## Fix

One shared helper, used by both arms, applied right after the finite check:

```ts
// result: the float answer; n1/n2: the number operands
if (exactRetry && !Number.isSafeInteger(result) && Number.isSafeInteger(n1) && Number.isSafeInteger(n2)) {
	return innerBigInt(BigInt(n1), BigInt(n2));
}
return result;
```

Why each guard is there:

- **`!Number.isSafeInteger(result)` first, and it is exact, not a heuristic.** Same argument as `addWithPromotion` in `func/builtins/aggregate.ts`: for `+ - *` over two safe integers, an exact answer inside the safe range is representable as a double, so the float answer is exact and in range; an exact answer outside it rounds to a double outside it. So "float result unsafe" ⇔ "exact result unsafe" — no narrowing (`canonicalizeInteger`) is needed on the retry, and no false retries. The common small-number path costs one `Number.isSafeInteger` call and allocates nothing. A fractional result (`7 / 2`, `1.5 * 2.5`) fails the operand guard and returns as before.
- **Both operands safe integers.** A whole `number` past the safe range (a REAL `1e20`) is not an exact integer; `BigInt()` of a fraction throws. This is the same routing rule as `isExactIntegerDomain` in `aggregate.ts` — consider exporting/sharing that predicate rather than restating it.
- **`/` and `%` never trigger it** (|a / b| ≤ |a| and |a % b| < |b| for nonzero integer b), but don't rely on the operand guard alone for that: restrict the retry to `+ - *` explicitly (e.g. pass `innerBigInt` only for those operators, or a boolean from the operator switch). The bigint `/` truncates, which would be wrong if ever reached.
- **`exactRetry` — decided at emit time from the announced result type.** JavaScript cannot tell `3.0` from `3`, so `cast(9007199254740991 as real) * cast(3 as real)` reaches the same body with two safe-integer `number`s, but is announced REAL, whose value space is `number` only (R2). Returning a `bigint` there would trade one R2 violation for another. Set `exactRetry` false when the announced type (`plan.getType().logicalType`) is REAL-class (`numericPromotionClass(...) === 'REAL'` in `types/builtin-types.ts`); INTEGER, NUMERIC and ANY all admit a `bigint`. A REAL × REAL product past 2^53 is legitimately an inexact double. (Mixed INTEGER × REAL is announced NUMERIC, so the retry applies — consistent with what `mixedBigIntArithmetic` already does for a `bigint` INTEGER against an integral REAL.) The REAL-stored-quantity arm (`runRealQuantity`) is untouched — it returns numbers by design.
- The temporal arms are unaffected (`tryTemporalArithmetic` returns first).

Remove the `NOTE:` in `buildCoercingArithmeticRun` that points at this ticket.

## Test

One generated spec (the reproduction, and the guard for the class): a new `test/integer-arithmetic-exact-boundary.spec.ts` (or a `describe` in `binary-op-static-type.spec.ts` / `announced-result-types.spec.ts` if one fits better). For operands drawn from around the boundary — e.g. `{0, 1, 2, 3, 2^26, 2^53−2, 2^53−1}` and their negatives — and operators `+ - *`, evaluate via SQL and assert:

- the value equals the exact answer computed with JS `BigInt`, compared after canonicalizing (`canonicalizeInteger`) — this covers both digits and representation;
- the value conforms to the column's announced type (`conformsToType` from `types/representation.ts` against `stmt.getColumnDefs()[0].type`).

Run each pair through both runtime arms: literal operands (numeric-fast) and one text-spelled operand (`'9007199254740991' * 3`, coercing arm). Add one REAL × REAL case asserting it still returns a `number` (the `exactRetry` gate). Keep it to one test per behaviour; no per-pair `it` explosion beyond what the loop needs.

Optionally add two sqllogic lines to `03.7-bigint-mixed-arithmetic.sqllogic` showing the user-visible result via `cast(9007199254740991 * 3 as text)` → `'27021597764222973'` (the JSON rendering of the result table can't show `bigint` vs `number`; `typeof()` says `integer` for both). Skip it if the spec already covers it — don't duplicate.

## Docs / comments to update after the fix

- `core/statement.ts` `_iterateWithSignal`: delete the `NOTE:` paragraph naming this ticket.
- `docs/types.md` ~line 222 ("The seam asserts that announcement. One known wrong-VALUE defect can still trip it…"): drop the defect sentence; keep the nullability sentence.

## Out of scope

Sibling instances (text operands with big digit strings, window/materialized-view `sum`) are already complete. Unary minus over safe integers cannot leave the range. Built-in scalar functions that multiply (none found doing integer products) are not part of this ticket.

## TODO

- Add the shared exact-retry helper in `runtime/emit/binary.ts`; restrict it to `+ - *`; gate with an emit-time `exactRetry` flag from the announced type (false for REAL-class).
- Apply it in `runNumericOnly` and in the number arm of `buildCoercingArithmeticRun`; remove the NOTE there.
- Consider sharing `isExactIntegerDomain` (aggregate.ts) instead of restating the safe-integer operand rule.
- Write the generated boundary spec (both arms + REAL gate); confirm it fails before the fix.
- Update the `statement.ts` NOTE and the docs/types.md paragraph.
- Run `yarn workspace @quereus/quereus test`, `yarn workspace @quereus/quereus test:repr-strict`, and `yarn workspace @quereus/quereus lint`.
