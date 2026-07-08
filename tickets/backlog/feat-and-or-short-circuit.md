----
description: SQL `AND` / `OR` always run both sides of the expression even when the first side already decides the answer, so an expensive second operand (like a subquery) runs needlessly.
files: packages/quereus/src/runtime/emit/binary.ts, packages/quereus/src/runtime/emit/case.ts, packages/quereus/src/runtime/emitters.ts
difficulty: medium
----
Boolean `AND` / `OR` are emitted with both operands as eager parameters (`emitLogicalOp` in `runtime/emit/binary.ts`), so the runtime scheduler evaluates *both* sides before the operator's `run` function is even called. When the second operand is expensive — e.g. a correlated scalar subquery — it runs on every row even when the first operand already fixes the result (`false AND x` is always `false`; `true OR x` is always `true`).

This was flagged in the runtime code review with the suggestion "emit non-trivial operands callback-style, as CASE already does." **Correction discovered during the cleanup pass:** CASE does *not* actually short-circuit today either — `runtime/emit/case.ts` emits every WHEN/THEN/ELSE as an eager param and carries a `// TODO: consider making all of these calls for short-circuiting` note. So there is no existing callback-style short-circuit pattern to copy; this ticket has to build it. (Whoever picks this up may want to fix CASE the same way in the same pass.)

## Expected behavior / use cases
- `select ... where cheap_col = 1 or (select count(*) from big) > 0` — when `cheap_col = 1` is true, the subquery must not run.
- `false and <expensive>` / `true or <expensive>` short-circuit; the expensive side is never evaluated.
- Three-valued logic must be preserved exactly. Short-circuit is only valid when the first operand *decides*:
  - `AND`: skip the right operand only when the left is `false` → result `false`. Left `true` or `NULL` still requires the right (`NULL AND false` = `false`, `NULL AND true` = `NULL`).
  - `OR`: skip the right operand only when the left is `true` → result `true`. Left `false` or `NULL` still requires the right.
  - `XOR` never short-circuits (both operands always needed).
- Operand evaluation order stays left-to-right; no observable side-effect reordering.

## Design constraints to resolve
- **Callback emission.** The right operand needs to be emitted as an on-demand callback (see `emitCall` / `emitCallFromPlan` in `runtime/emitters.ts`) rather than an eager param, and invoked from `run` only when needed. The callback's result may be a `Promise` (subquery), so the operator's `run` becomes potentially async — confirm the scheduler handles a mixed sync/async `run` return here (it detects a `Promise` return and switches modes).
- **Cost gating.** Keep the cheap eager path for trivial operands so the common case (`a and b` over two column reads) pays nothing extra. Gate on an operand-cost heuristic — e.g. `plan.right.getTotalCost()` above a threshold, or "contains a subquery / volatile call". Decide the threshold and where the cost/volatility signal comes from.
- **Which operand.** Only the *right* operand needs deferring (left is already evaluated first); or defer both symmetrically if that's simpler. Pick one and document why.

## Testing
- SQL-logic tests asserting the expensive side does NOT run when short-circuited (observe via a side-effecting/ counting construct, or row-count of an evaluated subquery).
- Full 3VL truth-table coverage for AND/OR/XOR including NULL operands, to prove semantics unchanged vs today's eager path.
- A trivial-operand case to confirm it stays on the eager path (no callback overhead).
