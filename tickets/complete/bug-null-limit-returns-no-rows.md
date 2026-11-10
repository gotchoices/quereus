---
description: A null or negative LIMIT / OFFSET is now an error (at prepare time where the value is knowable, otherwise per execution before any row is read) instead of silently returning no rows or every row; "no limit" is spelled by omitting the clause.
architecture: docs/sql-select.md#36-limit-and-offset-clauses
files:
  - packages/quereus/src/util/row-count.ts
  - packages/quereus/src/planner/building/row-count-expression.ts
  - packages/quereus/src/runtime/emit/limit-offset.ts
  - packages/quereus/src/runtime/emit/ordinal-slice.ts
  - packages/quereus/src/runtime/emit/recursive-cte.ts
  - packages/quereus/src/planner/building/select-modifiers.ts
  - packages/quereus/src/planner/building/select-compound.ts
  - packages/quereus/src/planner/building/with.ts
  - packages/quereus/src/planner/nodes/limit-offset.ts
  - packages/quereus/src/planner/nodes/function.ts
  - packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts
  - packages/quereus/src/planner/rules/aggregate/rule-minmax-index-boundary.ts
  - packages/quereus/src/planner/rules/join/rule-lateral-top1-asof.ts
  - packages/quereus/src/func/builtins/scalar.ts
  - packages/quereus/src/schema/function.ts
  - packages/quereus/src/func/registration.ts
  - packages/quereus/src/planner/building/function-call.ts
  - packages/quereus/test/logic/94.1-limit-offset-edge-cases.sqllogic
  - packages/quereus/test/optimizer/minmax-index-boundary.spec.ts
  - docs/sql-select.md
  - docs/types-inference.md
---

# Null / negative LIMIT and OFFSET are errors

## What landed

Maintainer decision (2026-11-10): a NULL or negative row count is an error for both `limit` and `offset`; `limit -1` means nothing special; "no limit" = omit the clause. Built in `ticket(implement): bug-null-limit-returns-no-rows`:

- An unwritten clause is `undefined` on `LimitOffsetNode` (was `Literal(null)`), so a NULL reaching the runtime is always a user value. `rule-grow-retrieve` now refuses on an absent OFFSET (same plans as before); `rule-minmax-index-boundary` builds `LimitOffset(1, undefined)`.
- `toRowCount` (`src/util/row-count.ts`) is the one runtime definition of a row count, used by the LimitOffset, OrdinalSlice and recursive-CTE emitters (and KeySetSemiJoin through `resolveWindow`). It runs before the source is first pulled, so a rejected count over a writing source writes nothing.
- `buildRowCountExpression` rejects at prepare a nullable-typed expression (except a parameter still untyped at plan time) and a negative constant, with the clause's source position.
- `coalesce` announces non-null when any argument is non-null (scalar `inferReturnType` gains an optional `argNullable` argument), so `limit coalesce((select max(n) from cfg), 10)` is accepted.

Usage: see docs/sql-select.md §3.6.

## Review findings

Read the implement diff first, then probed ~30 LIMIT/OFFSET shapes against the built engine (constants, casts, functions, subqueries, compound and nested selects, bound parameters, re-binding a prepared statement, a declared-ANY type map).

- **Fixed — non-numeric values coerced by plain `Number()`.** `toRowCount` doc says non-numeric values are errors, but `limit ''` returned 0 rows, `limit x'05'` read the blob as 5, and a JSON array `[5]` would read as 5. Added `rowCountNumber` in `row-count.ts`: numbers, bigints, booleans and numeric text (via the engine's `parseNumericText`) are read; blank text, blobs and JSON values name no number. `constantNumber` (plan-time) now uses the same function, so plan estimates and runtime agree. `describeValue` no longer `JSON.stringify`s a JSON value (would throw on a bigint inside). Two cases added to `94.1-limit-offset-edge-cases.sqllogic` (`limit ''`, `limit x'05'`) — the reproduction of this defect.
- **Fixed — stale comment** in `test/optimizer/minmax-index-boundary.spec.ts` still described the `Literal(null)` OFFSET.
- **Checked, correct:** `LimitOffsetNode.withChildren`/`getChildren` handle an absent offset; every consumer of `.offset` (monotonic pushdown, fanout-lookup, join elimination, key-set row bound, lateral top-1) treated the old `Literal(null)` as "no offset", so the absent form keeps their behaviour; no DML statement carries LIMIT (only `SelectStmt` does); compound, nested-subquery and `in (… limit null)` all go through the validator; re-binding `null` to a prepared `limit ?` fails at bind time and `-1` fails at runtime, as `docs/sql-select.md` claims; the declared-ANY path reaches the runtime NULL error.
- **Judgment call kept (flagged by implementer):** `limit 10 / 2` and `limit cast('2' as integer)` are rejected at prepare because those expressions are honestly announced nullable. This follows the decision literally and is documented in §3.6; whether to narrow `/` nullability is the maintainer's call, and the backlog ticket `debt-announced-nullability-disagrees-with-produced-nulls` (which the implementer annotated) owns over-claims. No new ticket.
- **Tripwire — stale inferred type on rewrite:** `ScalarFunctionCallNode.withChildren` keeps the type inferred from the original arguments; with coalesce's nullability now argument-dependent, a rewrite that made an argument nullable would leave a stale non-null claim. No rule does that today. Parked as a `NOTE:` in `src/planner/nodes/function.ts`.
- **Pre-existing bug found (out of scope), filed:** a parameter declared ANY through `db.prepare`'s type map rejects every non-null value (`Statement.validateParameterTypes` compares against ANY's physical type NULL) → `tickets/backlog/bug-any-typed-parameter-hint-rejects-every-value.md`.
- **Tests:** the implementer's tests each pin a branch of the decision (prepare vs runtime, zero rows pulled, OrdinalSlice throw path); none restate the implementation, none cut. The `toRowCount(null)` runtime branch is still reachable only through a declared-ANY type map and, given the bug above, stays untested there; it is the same helper the tested paths use.
- **Docs:** `docs/sql-select.md` §3.6 / recursive-CTE note / DML-subquery note and `docs/types-inference.md` read and accurate; no other doc mentions the old "null/negative clamps" behaviour.
- **Hygiene / types / resource cleanup / performance:** new files are small (≤60 lines); no `any`; no resources held; the per-execution check is one coercion per clause. Nothing to change.
- **Validation:** `yarn workspace @quereus/quereus run lint` clean; `yarn workspace @quereus/quereus run test` — 11139 passing, 26 pending. `yarn test:store` not run (no store-specific code touched).
