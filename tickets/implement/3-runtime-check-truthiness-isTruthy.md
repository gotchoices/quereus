----
description: A table's CHECK rule can be wrongly accepted when its result is a "false-like" value such as the number zero written as a big integer or the text "0", because the check uses a narrower notion of false than the rest of the engine.
files: packages/quereus/src/runtime/emit/constraint-check.ts, packages/quereus/src/runtime/emit/deferred-constraint-queue.ts
difficulty: easy
----
CHECK-constraint enforcement decides pass/fail with `result === false || result === 0`. That only treats the boolean `false` and the JS number `0` as failing. A CHECK expression that evaluates to `0n` (bigint zero) or `'0'` (the string zero) is treated as passing, which diverges from how the rest of the engine interprets truthiness — `FilterNode` and the shared `isTruthy` helper consider those values falsy. The result: a constraint that should reject a row silently admits it.

Expected behavior: CHECK enforcement must use the same truthiness rule as filters and every other predicate site, i.e. the shared `isTruthy` helper, so bigint-zero and string-zero (and any other value `isTruthy` deems false) correctly fail the constraint.

Two sites use the narrow comparison and both must change: `constraint-check.ts:368` and `deferred-constraint-queue.ts:104`.

## TODO
- Replace the `result === false || result === 0` failure test at `constraint-check.ts:368` with a call to the shared `isTruthy` helper (fail when not truthy).
- Apply the identical change at `deferred-constraint-queue.ts:104`.
- Add a logic test (`test/logic/`) asserting a CHECK expression returning `0n` / `'0'` rejects the row, and that a truthy CHECK still passes.
- Run the logic-test suite.
