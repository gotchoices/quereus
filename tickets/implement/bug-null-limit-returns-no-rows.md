---
description: Make a null or negative LIMIT / OFFSET an error instead of silently returning no rows (or every row, depending on which internal operator runs), rejecting it when the statement is prepared wherever the value is knowable then, and documenting that "no limit" is spelled by omitting the clause.
architecture: docs/sql-select.md#36-limit-and-offset-clauses
files:
  - packages/quereus/src/runtime/emit/limit-offset.ts             # resolveWindow: Infinity sentinel destroyed by the isFinite clamp
  - packages/quereus/src/runtime/emit/ordinal-slice.ts            # local coerceCount: null → Infinity, negative → 0, fractional → trunc
  - packages/quereus/src/runtime/emit/recursive-cte.ts            # lines ~36-48: its own copy of the clamp
  - packages/quereus/src/runtime/emit/key-set-semi-join.ts        # consumes resolveWindow for its rowBound
  - packages/quereus/src/planner/building/select-modifiers.ts     # applyLimitOffset: materializes an absent clause as Literal(null)
  - packages/quereus/src/planner/building/select-compound.ts      # applyOuterLimitOffset: same
  - packages/quereus/src/planner/building/with.ts                 # recursive-CTE outer limit/offset (already passes undefined when absent)
  - packages/quereus/src/planner/nodes/limit-offset.ts            # constantLimit() doc-comment claims null = no limit
  - packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts       # LimitOffset arm relies on Literal(null) OFFSET as "absent"
  - packages/quereus/src/planner/rules/aggregate/rule-minmax-index-boundary.ts # builds LimitOffset(1, Literal(null)) on purpose
  - packages/quereus/src/planner/rules/join/rule-lateral-top1-asof.ts       # isLiteralZeroOrUndefined treats null offset as absent
  - packages/quereus/src/planner/scopes/param.ts                  # unbound parameters are ANY, nullable
  - packages/quereus/src/core/param.ts                            # bind-time hint: nullable = (value === null)
  - packages/quereus/test/logic/104-emit-mutation-kills.sqllogic
  - packages/quereus/test/logic/94.1-limit-offset-edge-cases.sqllogic
  - packages/quereus/test/logic/01.9.1-limit-over-dml-subquery.sqllogic
  - packages/quereus/test/optimizer/minmax-index-boundary.spec.ts
  - packages/quereus/test/optimizer/monotonic-limit-pushdown.spec.ts
  - docs/sql-select.md
repro: verified
---

# Null / negative LIMIT and OFFSET become errors

## Decision being implemented (maintainer, 2026-11-10)

A null row count is an error, and so is a negative one — for both `limit` and `offset`. `limit -1` no longer means anything special. To ask for no limit, omit the clause.

- **Prepare time.** The LIMIT / OFFSET expression must have a non-nullable type (`getType().nullable === false`). `limit null`, `limit (select max(n) from cfg)` and any other nullable expression are rejected when the statement is prepared; a nullable source must be wrapped in `coalesce(…)`. A negative constant (`limit -1`, `offset -2`) is rejected at prepare time too.
- **Typed parameters.** A parameter whose type is known at plan time carries its nullability from that type (`core/param.ts` sets `nullable: value === null` from the bind-time hint), so `limit ?` prepared with a bound `null` is rejected at prepare time, and rebinding a non-null-typed parameter to null already fails at bind time (`statement.ts`, "expected non-nullable …").
- **Untyped parameters.** A parameter still ANY when the plan is built (`planner/scopes/param.ts` `DEFAULT_PARAMETER_TYPE`, nullable) must NOT be rejected at prepare time — otherwise `db.prepare('… limit ?')` with no args stops working (`test/logic/02.1-bind-parameters.sqllogic:194`, `key-set-semi-join-runtime.spec.ts:291`, `monotonic-limit-pushdown.spec.ts:91`). It gets a runtime check once per execution, when the limit value is read and **before any source row is pulled**.
- Consequence pinned by the decision: `select k from (insert into d select k from src returning k) limit ?` executed with `-1` (or null) raises the error and writes nothing. (With a literal `-1` it is rejected at prepare time, which also writes nothing.)

## Reproduction (memory backend, current HEAD build)

Table `t` has 4 rows; `src` has 4 rows; `d` is empty.

| statement | today | required |
|---|---|---|
| `select k from t limit null` | `[]` | prepare error |
| `select k from t limit -1` | `[]` | prepare error |
| `select k from t limit 2 offset null` | 2 rows | prepare error |
| `select k from t limit 2 offset -1` | 2 rows (offset clamped to 0) | prepare error |
| `select k from t limit ?` bound `[null]` | `[]` | error (prepare-time via bind hint) |
| `select k from t order by k limit (select max(k) from t where k > 10)` | `[]` | prepare error (subquery is nullable) |
| recursive CTE … `limit null` / `limit -1` | `[]` | prepare error |
| `select k from (insert into d select k from src returning k) limit -1` | `[]`, writes 4 rows | error, writes 0 rows |

Also observed while reproducing, not covered by the decision: `limit 'abc'` → `[]` (text coerces to `NaN`, clamped to 0), and `limit 2.5` → 3 rows in `limit-offset.ts` (it compares `emitted >= 2.5`) while `ordinal-slice.ts` truncates to 2. See "Non-numeric and fractional values" below.

## Root cause

There is no single definition of what a row count is. Three emitters each coerce the evaluated value themselves (`resolveWindow` in `limit-offset.ts`, `coerceCount` in `ordinal-slice.ts`, an inline copy in `recursive-cte.ts`) and disagree. Underneath that, the builder uses `Literal(null)` as the representation of "this clause was not written" (`select-modifiers.ts` `applyLimitOffset`, `select-compound.ts` `applyOuterLimitOffset`: every bare `limit n` gets an `offset` of `Literal(null)`), so null cannot become an error until "absent" has its own representation. `LimitOffsetNode` already accepts `undefined` for either expression (`withChildren`, `getChildren`, the emitter's argument order all handle it), and `with.ts` already passes `undefined` for an absent recursive-CTE clause.

## Design

### 1. Absent is `undefined`, never `Literal(null)`

`applyLimitOffset` and `applyOuterLimitOffset` pass `undefined` for an unwritten clause. Then a null that reaches the runtime is always a user value, and the runtime check can be unconditional.

This removes the sentinel two optimizer sites lean on — handle both in the same change:

- `rule-grow-retrieve.ts` LimitOffset arm (~line 428). Today a bare `limit n` is refused because its OFFSET is a non-numeric literal (null), and the long NOTE there explains that refusal is what keeps `rule-minmax-index-boundary`'s `LimitOffset(1, null)` from being swallowed into `Retrieve.source` (where the index-style branch of `ruleSelectAccessPath` never runs it, losing the early stop). Preserve today's behaviour exactly: **refuse when `lim.offset === undefined`** (absent offset → no limit pushed, same as today's null-literal refusal), keep the numeric-literal path for an explicit `offset k`, and rewrite the NOTE to say "absent OFFSET" instead of "`Literal(null)` OFFSET". Do not widen pushdown to bare `limit n` in this ticket — that is a separate optimizer change with its own guard requirement.
- `rule-minmax-index-boundary.ts` (~line 125) builds `new LimitOffsetNode(scope, absorbed, literal(scope, 1), literal(scope, null))`. Change the offset to `undefined` (a null offset would now raise at runtime) and update its load-bearing NOTE to reference the absent-offset refusal. `test/optimizer/minmax-index-boundary.spec.ts` "LIMITOFFSET survives directly above the access leaf" is the guard that this still holds — run it.
- `rule-lateral-top1-asof.ts` `isLimitOne` already treats `undefined` offset as absent; its null-literal branch becomes dead but harmless — simplify `isLiteralZeroOrUndefined` to the zero case.
- `LimitOffsetNode.constantLimit()` — drop the "literal NULL means no limit" comment and branch; a null literal can no longer survive building.

Grep for any other `LimitOffsetNode(` / `OrdinalSliceNode(` / `RecursiveCTENode(` construction that passes `literal(…, null)` (current construction sites: `select-modifiers.ts`, `select-compound.ts`, `rule-minmax-index-boundary.ts`, `rule-fanout-lookup-join.ts`, `rule-join-elimination.ts` — the last two copy an existing node's expressions, so they inherit the fix).

### 2. One shared runtime coercion

Replace the three coercions with one exported helper (suggested home: `runtime/emit/limit-offset.ts` next to `resolveWindow`, or a small `runtime/row-count.ts`), e.g.

```ts
/** Resolve an evaluated LIMIT / OFFSET value to a row count, or throw. */
export function toRowCount(value: SqlValue, clause: 'LIMIT' | 'OFFSET'): number
```

- `null` → throw (`QuereusError`, message naming the clause, e.g. "LIMIT must not be NULL; omit the clause for no limit").
- not a finite number after `Number(value)` → throw.
- negative → throw.
- otherwise `Math.trunc(n)`.

`resolveWindow` returns `{ limit: Infinity }` / `{ offset: 0 }` only when the corresponding `fn` is `undefined` (clause absent), otherwise `toRowCount(await fn(ctx), …)`. `ordinal-slice.ts` (delete `coerceCount`) and `recursive-cte.ts` call the same helper. `key-set-semi-join.ts` already goes through `resolveWindow`, so it picks the change up for free.

Ordering requirement: in `emitLimitOffset`'s `run`, `resolveWindow` is already awaited before the `for await` over `sourceRows`; confirm (by the DML test below) that no source row is pulled before the throw — the source async iterable must not have been started. Same for `ordinal-slice.ts` (bounds are resolved before the loop) and `recursive-cte.ts` (values read at lines ~39-40, before the base case runs).

Status code: pick one consistently and note it in `docs/errors.md` if that doc lists codes per condition — `StatusCode.MISMATCH` (datatype mismatch, what SQLite raises for a non-integer LIMIT) is the closest existing fit; `StatusCode.ERROR` is acceptable.

### 3. Prepare-time validation

One helper invoked from the three building sites (`applyLimitOffset`, `applyOuterLimitOffset`, `with.ts` recursive outer limit/offset), after `buildExpression`:

- If the built expression's type is nullable **and** it is not a parameter reference with the default ANY type → throw at prepare time ("LIMIT expression may be NULL; wrap it in coalesce(…)"). Identify the exempt case structurally: peel `CastNode` / `CollateNode`, and exempt only a `ParameterReferenceNode` whose `targetType.logicalType` is `ANY_TYPE` (an untyped parameter). A typed parameter (bind hint present) uses its own nullability like any other expression. Note `limit ? + 1` with an untyped `?` produces a nullable binary node and is rejected — acceptable (user can `coalesce`); call it out in the docs only if it turns out to matter in tests.
- If the expression is a numeric constant that is negative → throw. Detect constants by peeling `CastNode` / `CollateNode` to a `LiteralNode`, or a unary `-` over such a literal (the parser produces `unary '-'` over `literal 1` for `-1`). Share this with `LimitOffsetNode.constantLimit()` rather than writing a second peel — extract a `constantNumber(node)` helper (in `planner/nodes/limit-offset.ts` or `planner/analysis/predicate-shape.ts` next to `literalValue`) and have `constantLimit()` use it, which also lets `constantLimit()` see `-1` (moot once rejected, but keeps one definition).
- A literal `null` is nullable, so it is caught by the first rule — no special case.
- Order relative to the existing post-grouping check (`docs/sql-select.md` §3.3/§3.6: `select count(*) from t limit b` is rejected for naming an ungrouped column): that check fires inside `buildExpression`, so it naturally runs first; keep it that way.

### Non-numeric and fractional values

Not covered by the decision; resolved here as follows so the three emitters stop disagreeing: text or other non-numeric values that do not coerce to a finite number raise at runtime (same helper); fractional values truncate (`limit 2.5` → 2 rows), matching what `ordinal-slice.ts` already does. Prepare-time rejection of a text-typed LIMIT is NOT added (not asked for; would need a type-class rule). If the implementer finds a reason to diverge from this, record it in the review handoff.

## Tests

Rewrite, don't add parallel files:

- `test/logic/94.1-limit-offset-edge-cases.sqllogic` — replace "Negative LIMIT → treated as 0" and "Negative OFFSET → treated as 0" with expected-error cases (check the sqllogic error-expectation syntax used elsewhere in `test/logic/`).
- `test/logic/104-emit-mutation-kills.sqllogic` lines ~54-80 — replace the negative-limit, negative-offset, negative-limit-with-offset, null-limit and null-offset cases with error expectations; drop the "→ Infinity → caught by isFinite" comment. Keep the `limit 0` / offset-beyond-count cases.
- Add the runtime-path cases (parameter unbound at prepare, bound at execution) once each: `limit ?` bound to null and to `-1` raise; `offset ?` bound to `-1` raises. Use whatever harness `02.1-bind-parameters.sqllogic` uses for `limit ?` with bound values; if sqllogic can't bind at execute-only time, a small case in an existing spec.
- Pin the DML case in `test/logic/01.9.1-limit-over-dml-subquery.sqllogic` (or `test/runtime/early-stop-consumption.spec.ts` if the parameter must be bound after prepare): `select k from (insert into d select k from src returning k) limit ?` executed with `-1` raises and `select count(*) from d` is 0 afterwards.
- A nullable-expression prepare error: `limit (select max(k) from t where k > 10)` rejected; `limit coalesce((select max(k) from t where k > 10), 0)` accepted.
- Recursive CTE: one case — `limit -1` on a recursive CTE's outer compound rejected at prepare.
- Fractional: `limit 2.5` → 2 rows (one case, in 94.1).
- `monotonic-limit-pushdown.spec.ts` exercises `OrdinalSlice` with a test module advertising ordinal seek — run it; add one null-parameter case there only if no other test reaches `ordinal-slice.ts`'s throw path.

Run the full `yarn test` (plan/optimizer specs may reference the null-offset shape) and `yarn workspace @quereus/quereus run lint`.

## Docs

`docs/sql-select.md` §3.6 (LIMIT and OFFSET Clauses, ~line 794): state that both expressions must be non-null and non-negative; nullable expressions are rejected at prepare time (use `coalesce`), untyped parameters are checked per execution before any row is read (so a writing source under the LIMIT does nothing); fractional values truncate; to ask for no limit, omit the clause — noting this differs from SQLite (`limit -1` = no limit) and PostgreSQL (`limit null` / `limit all` = no limit). Also adjust §3.7 recursive-CTE limit paragraph (~line 1126) if it implies any different coercion, and the "`LIMIT` over a writing source drains too" paragraph (~line 53) to mention that a rejected row count stops the write before it starts.

## TODO

- Builder: pass `undefined` for absent LIMIT/OFFSET in `select-modifiers.ts` and `select-compound.ts`.
- `rule-grow-retrieve.ts`: refuse on absent offset (preserve today's behaviour), rewrite its NOTE; `rule-minmax-index-boundary.ts`: offset `undefined`, update NOTE; simplify `rule-lateral-top1-asof.ts` null branch; clean `constantLimit()` comment/branch.
- Shared `toRowCount` helper; route `resolveWindow`, `ordinal-slice.ts` (delete `coerceCount`), `recursive-cte.ts` through it.
- Prepare-time validator (nullable unless untyped-ANY parameter; negative constant) at the three build sites, sharing a `constantNumber` peel with `constantLimit()`.
- Rewrite pinned sqllogic cases; add runtime-parameter, DML-no-write, nullable-subquery/coalesce, recursive-CTE and fractional cases.
- Run `test/optimizer/minmax-index-boundary.spec.ts` and `monotonic-limit-pushdown.spec.ts` specifically, then `yarn test` and lint.
- Update `docs/sql-select.md` §3.6 (and the two related paragraphs).
