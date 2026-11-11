description: A prepared statement whose parameter was first given a real value (say 5) used to refuse NULL for that parameter on every later run. Now a type inferred from a bound value accepts NULL, and LIMIT / OFFSET expressions that are nullable only because of parameters are checked when the statement runs instead of when it is prepared.
architecture: docs/types-parameters.md#type-checking-and-validation
files: packages/quereus/src/core/param.ts, packages/quereus/src/planner/building/row-count-expression.ts, packages/quereus/src/planner/nodes/function.ts, packages/quereus/src/planner/building/function-call.ts, packages/quereus/test/parameter-types.spec.ts, packages/quereus/test/runtime/early-stop-consumption.spec.ts, docs/types-parameters.md, docs/sql-select.md
----
# Review: value-inferred parameter types are nullable

## What changed

**Inference (`src/core/param.ts`).** `getParameterScalarType` now returns `nullable: true` for every value; a null value still types the parameter ANY. A declared hint map is untouched, so `nullable: false` there still rejects NULL at bind (`validateParameterTypes` in `core/statement.ts` was not changed — its null branch now only fires for a declared non-null hint).

Reproduction from the ticket now passes: `update t set x = ? where k = ?` prepared with `[5, 1]`, then `run([null, 2])` stores NULL.

**LIMIT / OFFSET prepare check (`src/planner/building/row-count-expression.ts`).** `isUntypedParameter` is gone. A nullable LIMIT / OFFSET expression is accepted at prepare when a copy of it, rebuilt with every nullable parameter made non-null, is not nullable (`isNullableOnlyThroughParameters` → `withParametersAssumedNonNull` → `assumeNonNull`). The copy is discarded; the plan keeps the original node with the parameter's real nullable type. The walk descends scalar children only, so a scalar subquery stays nullable for its own reasons. A parameter declared `nullable: false` is left as it is. Kept as a local walk rather than extracting a shared helper: there are four or more similar walks in the planner (`substituteInScalar`, `substituteSubqueries`, `rewriteOutputToSource`, one in `rule-scalar-agg-decorrelation.ts`) with slightly different guards, and consolidating them is outside this ticket.

**Deviation from the ticket's mechanism — please check.** The ticket said to substitute `{ ...targetType, nullable: false }`. That alone does not satisfy the ticket's own requirement that `limit ? + 1` prepares with an unbound parameter: an unbound parameter is ANY, and `BinaryOpNode` announces `ANY + INTEGER` as nullable (only `+ - *` over two INTEGERs keeps operand nullability, because the runtime reads an ANY operand per row). So `assumeNonNull` also changes an ANY parameter's logical type to INTEGER, "the kind of value a row count is". Typed parameters keep their logical type. Consequences a reviewer might weigh:
- A REAL-typed parameter (inferred from `5.5`) in `limit ? + 1` is still rejected at prepare (`REAL + INTEGER` is nullable because of overflow). Same as before this change.
- A parameter declared ANY with `nullable: false` is not substituted, so `limit ? + 1` over it is rejected at prepare. Consistent with "declared non-null is judged as it is", but odd-looking.
- `docs/sql-select.md` §3.6 states the integer assumption.

**`ScalarFunctionCallNode.withChildren` (`src/planner/nodes/function.ts`).** Now re-runs `inferReturnType` on the new operands (new exported helper `inferScalarCallType`, also used by `building/function-call.ts` so the two cannot differ). A schema without `inferReturnType` keeps the type the node was built with (`rule-materialized-view-rewrite.ts` builds a synthetic `agg_combine` call with an explicit type). `validateArgTypes` is deliberately not re-run in `withChildren`. The old `NOTE:` is replaced by a comment saying why. This affects every optimizer rule that rewrites a function's arguments, not just the LIMIT check — the full suite passed, but this is the widest-reaching part of the diff. The ticket's suggested pin, `limit abs(?)`, does not need the fix (`abs` always announces non-null — a known misclaim, see `backlog/debt-announced-nullability-disagrees-with-produced-nulls`); `limit coalesce(?, 10) - ?` unbound does, and is the pin. Verified by temporarily disabling the re-inference: that case then fails with "LIMIT expression may be NULL".

Other scalar nodes reachable in a LIMIT expression (`UnaryOpNode`, `BinaryOpNode`, `CaseExprNode`, `CastNode`, `CollateNode`, `BetweenNode` in `nodes/scalar.ts`; `InNode` in `nodes/subquery.ts`) compute their type lazily from their children through `Cached(generateType)`, so a rebuilt instance recomputes. Read, not tested individually. `InNode` is always nullable.

**Docs.** `docs/types-parameters.md`: inference section states every inferred type is nullable; the NULL-compatibility bullet and the LIMIT bullet under "A first binding of `null`" are rewritten; a paragraph says declaring `nullable: false` keeps NULL refused at bind and the planner's non-null facts. `docs/sql-select.md` §3.6 "Valid row counts": both bullets rewritten as the ticket asked, plus the integer assumption.

## Tests added

- `test/parameter-types.spec.ts` › "accepts NULL on a later run for a parameter typed by a non-null first value" — the reproduction (update prepared with `[5, 1]`, run with `[null, 2]`, NULL stored).
- `test/parameter-types.spec.ts` › "should work with explicit type hints" (extended) — a declared `nullable: false` hint still rejects `null` at bind; the nullable hint accepts it.
- `test/runtime/early-stop-consumption.spec.ts` › "an expression nullable only through its parameters prepares, and a NULL raises at execution" — `limit ?` prepared with `[2]`, `limit ? + 1` prepared with `[1]` and unbound, `limit coalesce(?, 10) - ?` unbound: each plans (forced with `getColumnDefs()` before binding), then a NULL fails at run with "LIMIT must not be NULL" and no source row is read. Also `limit ? / 2` is still rejected at prepare, which covers the "still nullable after assuming non-null parameters" branch.

Existing prepare-time rejections in `test/logic/94.1-limit-offset-edge-cases.sqllogic` and `test/logic/104-emit-mutation-kills.sqllogic` pass unchanged. No existing test pinned a non-nullable inferred parameter type, so none needed updating.

## Validation

- `yarn workspace @quereus/quereus run lint` — exit 0.
- `yarn test` — all workspaces pass (quereus: 11146 passing, 26 pending; 0 failing anywhere).
- Not run: `yarn test:store`, the strict-mode variants.

## Things to look at

- Whether the ANY → INTEGER assumption is acceptable, or whether the rule should be stated differently (for example: assume every nullable parameter is a non-null INTEGER regardless of its type).
- Plan-wide effect of `withChildren` re-inference: a rule that swaps a function's argument for one of a different logical type now changes the call's announced type mid-optimization. No test caught a problem, but a rule whose output attributes were typed from the pre-rewrite call could disagree.
- Making inferred parameters nullable removes planner facts elsewhere (for example `select ? as v` prepared with `[5]` now announces a nullable INTEGER). The ticket's search found no prepare-time rejection other than LIMIT / OFFSET driven by nullability, and no test changed, but plan quality for `col = ?` shapes was not measured.
