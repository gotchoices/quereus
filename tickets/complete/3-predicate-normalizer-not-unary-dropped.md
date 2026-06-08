description: Fix pushNotDown dropping NOT wrapper on non-NOT unary ops (e.g. NOT(-x) → -x)
prereq: none
files:
  packages/quereus/src/planner/analysis/predicate-normalizer.ts
  packages/quereus/test/optimizer/predicate-analysis.spec.ts
----
## Summary

Fixed a copy-paste bug in `pushNotDown()` where `NOT(unary_op(x))` for non-NOT unary operators
(e.g. unary minus `-`) silently dropped the NOT wrapper, returning just `unary_op(normalize(x))`.

The fix (lines 85-89 of `predicate-normalizer.ts`) normalizes the inner operand, rebuilds
the inner unary node only when the operand changed, then wraps it in a NOT UnaryOpNode.

## Review Notes

- Fix follows the same reference-equality allocation-avoidance pattern used throughout the file
- AST for the NOT wrapper correctly references the inner expression
- No unnecessary changes beyond the fix

## Tests

Two test cases in `predicate-analysis.spec.ts` (lines 127-148):
- `NOT(-col)` normalizes to `NOT(-col)` — NOT preserved around unary minus
- `NOT(NOT(-col))` normalizes to `-col` — double negation elimination works with inner unary ops

All 1013 tests pass. Build clean.
