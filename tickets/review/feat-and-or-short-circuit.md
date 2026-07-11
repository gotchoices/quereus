description: SQL `AND` / `OR` now skip an expensive right-hand subquery when the left side already decides the answer, instead of running it on every row for nothing.
files: packages/quereus/src/runtime/emit/binary.ts, packages/quereus/test/and-or-short-circuit.spec.ts, packages/quereus/test/logic/07.7-and-or-short-circuit.sqllogic
difficulty: medium

## What was built

`emitLogicalOp` (`runtime/emit/binary.ts`) now short-circuits `AND`/`OR` when the
**right** operand contains a subquery. Instead of emitting both operands as eager
scheduler params, the right operand is emitted as an on-demand callback
(`emitCallFromPlan`) and invoked from an `async` `run` only when the left operand
does not already decide the result:

- `AND`: skip the right when left is `false` → result `false`.
- `OR`:  skip the right when left is `true`  → result `true`.
- Left `NULL` (or the non-deciding boolean) still requires the right, exactly as
  before.

Three emit branches:

| case | path |
|------|------|
| `XOR` (any operands) | unchanged eager two-param `run` |
| `AND`/`OR`, right has **no** subquery | unchanged eager two-param `run` |
| `AND`/`OR`, right **has** a subquery | `params: [left, emitCallFromPlan(right)]`, `async runShortCircuit` |

The deferred instruction carries a distinct note `AND(logical short-circuit)` /
`OR(logical short-circuit)` (vs `AND(logical)` for the eager path) so EXPLAIN /
`getDebugProgram()` shows which path was taken.

### Gate: `containsSubquery(node)`

A cheap emit-time recursive walk over `getChildren()` that returns true if any
descendant is relational (`isRelationalNode`). Scalar/IN/EXISTS subqueries expose
their relational child via `getChildren()`, so this catches them all — including a
**tableless** subquery like `(select sidefx())`, whose self-cost is tiny (this is
the concrete reason the gate is subquery-containment, not a cost threshold). It
mirrors the existing `conjunctHasSubquery` helper in
`planner/analysis/query-rewrite-matcher.ts`. Kept local to `binary.ts` (CASE
short-circuit does not need it — coordinated per the plan ticket).

### 3VL correctness

`runShortCircuit` reuses the exact same `isTruthy` (SQL truthiness, not JS) and the
same three-valued combine as the eager `run` — the only difference is the right
operand is fetched lazily. The async return flips the scheduler into its async
continuation loop (same path `limit-offset` / `sink` already rely on), so no
scheduler change was needed.

## How to validate

```
yarn workspace @quereus/quereus test          # full suite: 6947 passing, 0 failing
yarn workspace @quereus/quereus lint           # eslint + tsc test-file typecheck: clean
node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js \
  "packages/quereus/test/and-or-short-circuit.spec.ts" --colors   # 12 passing
```

### Test coverage added

`test/and-or-short-circuit.spec.ts` (JS harness — owns the side-effect / emit-note
assertions that need a UDF):
- **Full 3VL parity** for AND/OR/XOR over all nine `{true,false,null}²` inputs,
  driving BOTH paths (pure-scalar column RHS = eager; correlated-subquery RHS =
  deferred) and asserting both equal the reference truth table.
- **Non-evaluation** via a counting UDF wrapped in `(select sidefx())`:
  - OR in WHERE (`k = 1 or (select sidefx()) = 1`): counter = 2 over 3 rows —
    proves per-row deferral (not 3 = eager-every-row, not 1 = hoist-once; sidefx is
    non-deterministic so it can't be cached/hoisted).
  - AND in a SELECT-list projection: counter = 1 (only the left-true row), and = 0
    when left is false for every row.
  - A **throwing** UDF wrapped in a subquery is never reached → no throw.
- **Correlated** deferred RHS resolves its outer row when invoked lazily.
- **Nested** `a and (b or (subquery))`.
- **Emit gate**: trivial two-column AND stays eager (`(logical)`, no `SUB-PROGRAMS`);
  subquery RHS emits `logical short-circuit` + `SUB-PROGRAMS`; XOR never defers.

`test/logic/07.7-and-or-short-circuit.sqllogic` (end-to-end through the SQL runner):
full AND/OR/XOR truth tables, eager vs correlated-subquery-deferred forms, plus a
WHERE-clause OR and a nested short-circuit.

## Known gaps / things for the reviewer to probe

- **WHERE-clause top-level `AND` does NOT go through this short-circuit.** The
  optimizer decomposes a top-level conjunction in WHERE into *separate* `filter`
  nodes (verified via `getDebugProgram()`), so there is no `AND` binary op left at
  emit and `containsSubquery` never runs. Whether the subquery filter then runs
  per-row depends on **optimizer filter ordering**, which is unrelated to this
  ticket — in the plan I inspected, the subquery filter ran for every row even when
  a cheap sibling conjunct (`k = 2`) would have eliminated most rows first. This is
  pre-existing behavior, but it means the "expensive subquery in a WHERE `AND`"
  case from the ticket motivation is only addressed when the `AND` survives as a
  scalar binary op (SELECT list, ON clause, CASE, a nested/non-top-level AND, or
  **any** OR). A reviewer deciding this ticket is "done" should weigh whether the
  WHERE-`AND` filter-ordering case warrants a follow-up (conjunct cost-ordering) —
  I judged it out of scope and did not file a ticket, but it is the most likely
  place a user's expectation ("my `where cheap and (select expensive)` is slow")
  goes unmet. The spec documents this explicitly in the `AND (SELECT-list)` test
  comments.
- **Non-subquery expensive scalar operands stay eager** (accepted tradeoff from the
  plan). Recorded as a `NOTE:` tripwire comment at the gate site in `binary.ts`
  (extend the gate with a cost/volatility check if such an operand ever shows up
  hot) — deliberately not a ticket.
- **Decorrelation interaction.** If the optimizer ever rewrites a subquery RHS into
  a join (decorrelation), the operand no longer contains a `ScalarSubquery` at emit
  and falls back to the eager path. Correctness is unaffected (parity holds); the
  deferral simply doesn't apply. Not observed in the tests here, but worth a glance
  if a reviewer expects deferral on a specific decorrelatable shape.
- **docs/runtime.md was not changed.** It has no logical-operator-emission section
  to update, and AGENTS.md forbids adding summary docs. The behavior is documented
  in-code at the emit site (gate rationale, tripwire, 3VL-parity comment).

## Review findings

- Noticed: a top-level `AND` in a WHERE clause is split into independent `filter`
  nodes, so this binary-op short-circuit does not cover it; that path is governed by
  optimizer filter ordering. Parked as prose in this handoff (above) and in the
  `AND (SELECT-list)` test comments in `test/and-or-short-circuit.spec.ts` — not a
  ticket, since it is pre-existing and orthogonal to the binary-op change.
- Noticed: non-subquery expensive scalar operands stay eager. Parked as a `NOTE:`
  tripwire at the gate in `packages/quereus/src/runtime/emit/binary.ts`.
