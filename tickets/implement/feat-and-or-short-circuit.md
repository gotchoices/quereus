----
description: SQL `AND` / `OR` always run both sides even when the first side already decides the answer, so an expensive second operand (like a subquery) runs on every row for nothing — make the second side run only when it's actually needed.
files: packages/quereus/src/runtime/emit/binary.ts, packages/quereus/src/runtime/emit/limit-offset.ts, packages/quereus/src/runtime/emitters.ts, packages/quereus/src/planner/nodes/plan-node.ts, packages/quereus/src/planner/nodes/subquery.ts, packages/quereus/test/logic/07.6-subqueries.sqllogic
difficulty: medium
----

## Problem

`emitLogicalOp` in `runtime/emit/binary.ts` emits both operands of `AND` / `OR` / `XOR` as eager `params`. The runtime scheduler evaluates *both* params before the operator's `run` is even called. When the right operand is expensive — a correlated scalar subquery — it runs on every row even when the left operand already fixes the result (`false AND x` → `false`; `true OR x` → `true`).

## Chosen design

Defer the **right** operand as an on-demand callback (only when it warrants it), invoke it from `run` only when the left operand does not already decide the result. Left stays eager (it is always needed, always evaluated first). XOR is never touched (both operands always required).

### The callback mechanism already exists — copy `limit-offset.ts`

`emitCallFromPlan(plan, ctx)` (`runtime/emitters.ts:148`) emits a plan node and wraps it as a callback instruction: its `run` returns a function `(innerCtx) => program.run(innerCtx)`. `runtime/emit/limit-offset.ts` is the reference consumer — it receives operands typed `(ctx: RuntimeContext) => MaybePromise<SqlValue>` and does `await limitFn(ctx)` inside an `async run`. Copy that shape exactly.

The callback's result may be a `Promise` (scalar subquery). The operator's `run` therefore becomes `async`. The scheduler detects a `Promise` return from `run` and switches from its synchronous entry loop to the async continuation loop (`runtime/scheduler.ts:206`) — this is the same path `limit-offset` and `sink` already rely on, so no scheduler change is needed.

### Gating: defer only when the right operand contains a subquery

Do **not** make every `a and b` pay callback overhead. Emit the right operand as a callback only when its subtree contains a subquery (a relational descendant); otherwise keep today's eager two-param path unchanged.

Detection is a cheap emit-time walk of `plan.right`: recurse `getChildren()` and return true if any node satisfies `isRelationalNode(node)`. Scalar-subquery / IN-subquery / EXISTS nodes expose their relational subtree via `getChildren()` (e.g. `ScalarSubqueryNode.getChildren()` returns `[this.subquery]`, see `planner/nodes/subquery.ts:41`). Pure scalar operands (column refs, literals, arithmetic, deterministic function calls) have no relational descendant → they stay on the zero-overhead eager path.

**Why "contains a subquery" and not `getTotalCost() > threshold`:** the cost heuristic was the other candidate (the plan-stage ticket floated both). Subquery-containment was chosen because it is deterministic, needs no tuned magic number, targets exactly the expensive/side-effecting case named in every use case, and — critically — guarantees a *tableless* subquery like `(select sidefx())` also defers, which a cost threshold could let slip under (its self-cost is tiny). Pure scalar operands that stay eager are cheap anyway, so not deferring them costs nothing meaningful.

**Tradeoff (documented, accepted):** a very expensive *non-subquery* scalar operand (deeply nested arithmetic, or a slow volatile UDF called directly, not inside a subquery) is still evaluated eagerly. Such operands are rare and the dominant expensive case in SQL is the subquery. Record this as a `NOTE:` tripwire at the gate site: *if a non-subquery volatile/expensive scalar operand ever shows up hot, extend the gate with a cost or volatility check.* Do **not** file it as a ticket.

### Three-valued logic must be byte-identical to today

Short-circuit is valid only when the left operand *decides*:

- `AND`: skip the right operand only when left is `false` → result `false`. Left `true` or `NULL` still requires the right (`NULL AND false` = `false`, `NULL AND true` = `NULL`).
- `OR`: skip the right operand only when left is `true` → result `true`. Left `false` or `NULL` still requires the right.

The deferred `run` mirrors the existing eager 3VL combine exactly — it just fetches the right operand lazily:

```
async function runShortCircuit(ctx, v1, rightFn) {
  const b1 = v1 === null ? null : isTruthy(v1);
  if (operator === 'AND' && b1 === false) return false;   // left decides
  if (operator === 'OR'  && b1 === true)  return true;     // left decides
  const v2 = await rightFn(ctx);
  const b2 = v2 === null ? null : isTruthy(v2);
  // identical combine to the eager path below
  if (operator === 'AND') {
    if (b1 === false || b2 === false) return false;
    if (b1 === null  || b2 === null)  return null;
    return true;
  }
  // OR
  if (b1 === true || b2 === true) return true;
  if (b1 === null || b2 === null) return null;
  return false;
}
```

Keep `isTruthy` (SQL truthiness, not JS) exactly as the current eager `run` uses it — see the comment at `binary.ts:329-335` explaining why blobs / non-numeric strings must agree with `FilterNode`/CASE/NOT. Operand evaluation order stays left-to-right: left is a scheduler-evaluated param (runs first); the right callback fires inside `run` strictly afterward.

### Emit-time branching in `emitLogicalOp`

```
XOR                          → existing eager path, params [left, right]
AND/OR, right has no subquery → existing eager path, params [left, right]   (unchanged)
AND/OR, right has a subquery  → params [left, emitCallFromPlan(plan.right, ctx)],
                                run = async runShortCircuit above
```

Keep the current eager `run` verbatim for the non-deferred branches — do not rewrite it. Give the deferred instruction a distinct `note` (e.g. `AND(logical short-circuit)`) so EXPLAIN/trace shows which path was taken.

## Edge cases & interactions

- **Full 3VL parity.** The deferred combine must equal the eager combine for all 9 `{true,false,null}²` inputs per operator. This is the primary correctness risk — assert it directly (see Testing).
- **Correlated right operand.** A correlated scalar subquery on the RHS must still resolve its outer column when invoked lazily. The callback runs with the same `RuntimeContext` (`rightFn(ctx)`), so the outer row slot is installed — but verify with an actual correlated-subquery test, since this is the behavioral change from "emitted as a top-level param in the outer scheduler" to "emitted as its own sub-program invoked on demand".
- **Nested short-circuit.** `a and (b or (select ...))` — the inner `or` is itself the deferred right operand of the outer `and`; the inner operator emits normally inside the sub-program and short-circuits on its own. Confirm composition (one test).
- **Async error path.** If `rightFn(ctx)` rejects, the `await` propagates; the scheduler's async loop already sweeps abandoned parked promises on throw (`scheduler.ts:322`). No new handling needed, but do not swallow — let it propagate.
- **Metrics / tracing modes.** The deferred right becomes its own sub-program (`programs: [program]` from `emitCall`). When short-circuited, that sub-program runs 0 times — expected. No metrics/trace change required; just don't assume the RHS instruction always executes.
- **XOR untouched.** Confirm XOR still emits both operands eagerly and its truth table is unchanged.
- **Right operand with a subquery but left decides on the very first row.** Ensure the subquery genuinely does not execute (observable side-effect test), not merely that the result is correct.

## Testing

Add SQL-logic coverage (extend `test/logic/07.6-subqueries.sqllogic` or add a focused file) plus, if a JS harness is easier for the side-effect counter, a `.spec.ts` using `db.createScalarFunction` (see `test/core-api-features.spec.ts`).

- **Side-effect / non-evaluation.** Register a counting (or throwing) scalar UDF and wrap it in a scalar subquery so it trips the subquery gate — e.g. `(select sidefx())`. Then:
  - `where cheap_col = 1 or (select sidefx()) > 0` — assert the counter increments only for rows where `cheap_col <> 1`.
  - `where false and (select sidefx()) = 1` — assert the counter stays 0.
  - The `select sidefx()` (tableless) subquery must trip the gate — this is the concrete reason the gate is subquery-containment, not a cost threshold. Confirm it defers.
- **Full 3VL truth tables** for `AND` / `OR` / `XOR`, all `{true,false,null}²`, proving results are unchanged vs today. Drive both paths: a pure-scalar RHS (eager) and a subquery-wrapped RHS (deferred) must produce identical results for every combination.
- **Trivial-operand stays eager.** `a and b` over two column reads must not emit a callback (assert via EXPLAIN `note`, or that no sub-program is created) — proves the common case pays nothing.
- **Correlated + nested** cases from Edge cases above.

## TODO

- Add a `containsSubquery(node: ScalarPlanNode): boolean` helper (emit-time subtree walk over `getChildren()` testing `isRelationalNode`). Place it in `binary.ts` (or a small shared util if `feat-case-short-circuit` will reuse it — coordinate; CASE actually does not need it, so local to `binary.ts` is fine).
- In `emitLogicalOp`, branch emit as specified: XOR and no-subquery-RHS keep the existing eager path verbatim; AND/OR with a subquery RHS emit the RHS via `emitCallFromPlan` and install the `async runShortCircuit`.
- Add the `NOTE:` tripwire comment at the gate about non-subquery expensive operands.
- Add tests: side-effect non-evaluation, full 3VL truth tables (both paths), trivial-eager, correlated, nested.
- Run `yarn workspace @quereus/quereus test` and `yarn lint` (lint type-checks test files too). Stream long output with `2>&1 | tee`.
- Update `docs/runtime.md` if it documents logical-operator emission (short-circuit behavior + the subquery gate).
