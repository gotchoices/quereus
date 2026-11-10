---
description: A null or negative LIMIT / OFFSET is now an error (at prepare time where the value is knowable, otherwise per execution before any row is read) instead of silently returning no rows or every row; "no limit" is spelled by omitting the clause. Review the implementation.
architecture: docs/sql-select.md#36-limit-and-offset-clauses
files:
  - packages/quereus/src/util/row-count.ts                          # NEW: toRowCount — the one runtime definition of a row count
  - packages/quereus/src/planner/building/row-count-expression.ts   # NEW: buildRowCountExpression — prepare-time validator
  - packages/quereus/src/runtime/emit/limit-offset.ts               # resolveWindow → toRowCount
  - packages/quereus/src/runtime/emit/ordinal-slice.ts              # coerceCount deleted → toRowCount
  - packages/quereus/src/runtime/emit/recursive-cte.ts              # inline clamp → toRowCount
  - packages/quereus/src/planner/building/select-modifiers.ts       # absent clause = undefined (was Literal(null))
  - packages/quereus/src/planner/building/select-compound.ts        # same
  - packages/quereus/src/planner/building/with.ts                   # recursive-CTE outer limit/offset through validator
  - packages/quereus/src/planner/nodes/limit-offset.ts              # exported constantNumber(); constantLimit() uses it
  - packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts       # refuses on ABSENT offset (was: null-literal offset)
  - packages/quereus/src/planner/rules/aggregate/rule-minmax-index-boundary.ts # LimitOffset(1, undefined)
  - packages/quereus/src/planner/rules/join/rule-lateral-top1-asof.ts       # isLiteralZero (null branch gone)
  - packages/quereus/src/func/builtins/scalar.ts                    # coalesce announces non-null when any arg is non-null
  - packages/quereus/src/schema/function.ts                         # inferReturnType gains optional argNullable
  - packages/quereus/src/func/registration.ts                       # same
  - packages/quereus/src/planner/building/function-call.ts          # passes argNullable
  - packages/quereus/test/logic/94.1-limit-offset-edge-cases.sqllogic
  - packages/quereus/test/logic/94.2-limit-offset-extras.sqllogic
  - packages/quereus/test/logic/104-emit-mutation-kills.sqllogic
  - packages/quereus/test/logic/13.4-cte-extras.sqllogic
  - packages/quereus/test/runtime/early-stop-consumption.spec.ts
  - packages/quereus/test/optimizer/monotonic-limit-pushdown.spec.ts
  - docs/sql-select.md
  - docs/types-inference.md
---

# Null / negative LIMIT and OFFSET are errors — review handoff

## What the maintainer decided (2026-11-10)

A NULL row count is an error, and so is a negative one, for both `limit` and `offset`. `limit -1` means nothing special. "No limit" = omit the clause. Nullable-typed expressions are rejected at prepare (wrap in `coalesce`); negative constants are rejected at prepare; an **untyped** parameter (still ANY when planned) is exempt at prepare and checked per execution, before any source row is pulled.

## What was built

- **Absent clause has its own representation.** `applyLimitOffset` / `applyOuterLimitOffset` pass `undefined` for an unwritten clause instead of `Literal(null)`. So a NULL reaching the runtime is always a user value. Side effect: `offset`-only statements (if the parser ever allows them) no longer get a `Literal(null)` LIMIT that meant zero rows.
- **One runtime coercion** `toRowCount(value, clause, at?)` in `src/util/row-count.ts` (put in `util/` rather than `runtime/emit/` because the planner's prepare-time check calls it too). NULL → error, non-finite after `Number()` → error, negative → error, else `Math.trunc`. All three emitters (`limit-offset.ts`, `ordinal-slice.ts`, `recursive-cte.ts`) use it; `key-set-semi-join.ts` gets it through `resolveWindow`. Status code `MISMATCH` (`docs/errors.md` lists codes generally, not per condition, so it is unchanged).
- **Prepare-time validator** `buildRowCountExpression` used by all three build sites: rejects `getType().nullable` unless the expression (after peeling Cast/Collate) is a `ParameterReferenceNode` with `ANY_TYPE`; rejects a negative constant by running `toRowCount` on `constantNumber(node)` (shared with `LimitOffsetNode.constantLimit()`). Errors carry the clause's source line/column.
- **Optimizer sentinel replaced.** `rule-grow-retrieve` now refuses on `lim.offset === undefined` — exactly today's behaviour (every bare `limit n` used to have a `Literal(null)` offset and was refused). `rule-minmax-index-boundary` builds `LimitOffset(1, undefined)`; both NOTEs rewritten. `minmax-index-boundary.spec.ts` passes ("LIMITOFFSET survives directly above the access leaf").
- **`coalesce` nullability (not in the ticket, needed by it).** `coalesce`'s `inferReturnType` hard-coded `nullable: true`, so the decision's escape hatch `limit coalesce((select max(k) …), 0)` was itself rejected. Scalar `inferReturnType` now takes an optional second argument `argNullable: boolean[]` (passed only from `function-call.ts`), and `coalesce` announces non-null when any argument is non-null. This also touches the backlog ticket `debt-announced-nullability-disagrees-with-produced-nulls`; I appended a note there.

## Known gaps / judgment calls for the reviewer

- **`limit 10 / 2` is now rejected at prepare** ("LIMIT expression may be NULL"), because `BinaryOpNode` honestly announces `/` and `%` as nullable (x / 0 is NULL). This follows the decision literally. It changed one case adapted from SQLite in `94.2-limit-offset-extras.sqllogic` (`limit 4 / 2` → `limit 4 - 2`, with a comment) and is called out in `docs/sql-select.md` §3.6. If the maintainer finds that too strict, the narrow fix is in `BinaryOpNode.generateType`: announce non-null for `/` / `%` over non-null INTEGER operands when the divisor is a non-zero literal. I did not do that.
- **Nullability over-claims are now user-visible.** Any expression announced nullable that cannot actually be NULL is rejected as a LIMIT. Under-claims (announced non-null, produces NULL, e.g. `abs(nullable_col)`) pass prepare and are caught by the runtime check. Both directions are the backlog nullability-debt ticket's territory.
- **`constantNumber` peels casts** and judges the literal underneath, so `limit cast(-0.5 as integer)` (which is 0 at runtime) is rejected at prepare. Contrived; a NOTE at the helper records it.
- **The ticket's suggested "unary minus over a literal" peel was not needed:** `buildExpression` already folds `-1` into `Literal(-1)`. Anything the prepare check misses (e.g. `limit 1 - 2`) is caught at runtime.
- **Non-numeric values:** `limit 'abc'` is a runtime error (not prepare), as the ticket specified. No type-class rule was added.
- **Untyped-parameter runtime NULL path has no test.** In practice a parameter is untyped at plan time only when declared ANY via a type-hint map (`db.prepare(sql, new Map(...))`): a bind after an early compile invalidates the plan and replans with the bound value's type (`Statement.dropStalePlanOnBind`). So `limit ?` bound to `null` through the normal API is rejected at prepare (pinned), and `-1` takes the runtime path (pinned). The `toRowCount(null)` branch at runtime is reached only through a declared-ANY hint map; it is the same helper and is untested there.
- **sqllogic `-- error:` blocks ignore `-- params:`**, and the corpus is shared with downstream harnesses, so I did not extend that contract. The bound-parameter cases live in specs instead.

## Tests (added or rewritten) and what each verifies

- `94.1-limit-offset-edge-cases.sqllogic`: negative LIMIT / OFFSET → prepare error (rewritten from "treated as 0"); `limit 2.5` → 2 rows (truncation); nullable subquery LIMIT → prepare error, and the `coalesce(…, 0)` form is accepted; `limit 'abc'` → runtime error.
- `104-emit-mutation-kills.sqllogic`: the negative / null limit and offset cases are now error expectations ("→ Infinity → isFinite" comment gone); `limit 0` / offset-beyond-count kept.
- `13.4-cte-extras.sqllogic`: recursive CTE `limit -1` → prepare error.
- `94.2-limit-offset-extras.sqllogic`: `4 / 2` → `4 - 2` (see gaps).
- `early-stop-consumption.spec.ts` › "a rejected LIMIT / OFFSET reads nothing": (1) `limit ?` / `offset ?` bound to `-1` raise with **zero rows pulled** from the counting module (the runtime check fires before the source starts); (2) `limit ?` bound to `null` is rejected at prepare; (3) the decision's pinned case, `select k from (insert into dst select k from counting returning k) limit ?` bound to `-1`, raises, pulls zero source rows (the proof — statement rollback alone would also leave `dst` empty) and leaves `dst` empty.
- `monotonic-limit-pushdown.spec.ts`: `LIMIT ? OFFSET ?` bound `[3, -1]` raises through `OrdinalSlice` (nothing else reaches that emitter's throw path).

## Validation run

- `yarn test` (all workspaces): all passing.
- `yarn workspace @quereus/quereus run lint` (eslint + test-file tsc): exit 0.
- `minmax-index-boundary.spec.ts`, `monotonic-limit-pushdown.spec.ts`, `key-set-semi-join-runtime.spec.ts`, `early-stop-consumption.spec.ts`: passing (also run on their own).
- `yarn test:store` not run.

## Usage for a quick manual check

```sql
create table t (k integer primary key); insert into t values (1),(2),(3),(4);
select k from t limit null;            -- error at prepare: LIMIT expression may be NULL
select k from t limit -1;              -- error at prepare: LIMIT must not be negative
select k from t limit 2 offset null;   -- error at prepare: OFFSET expression may be NULL
select k from t order by k limit coalesce((select max(k) from t where k > 10), 2);  -- 2 rows
select k from t limit 2.5;             -- 2 rows
select k from t;                       -- "no limit": omit the clause
```
