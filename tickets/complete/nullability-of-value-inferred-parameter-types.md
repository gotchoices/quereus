description: A prepared statement whose parameter was first given a real value (say 5) used to refuse NULL for that parameter on every later run. Now a type inferred from a bound value accepts NULL, and LIMIT / OFFSET expressions that are nullable only because of parameters are checked when the statement runs instead of when it is prepared.
architecture: docs/types-parameters.md#type-checking-and-validation
files: packages/quereus/src/core/param.ts, packages/quereus/src/planner/building/row-count-expression.ts, packages/quereus/src/planner/nodes/function.ts, packages/quereus/src/planner/building/function-call.ts, packages/quereus/test/parameter-types.spec.ts, packages/quereus/test/runtime/early-stop-consumption.spec.ts, docs/types-parameters.md, docs/sql-select.md
----
# Value-inferred parameter types are nullable

## What landed

Landed in `ticket(implement): nullability-of-value-inferred-parameter-types`.

- **Inference (`core/param.ts`).** `getParameterScalarType` returns `nullable: true` for every value; a null value still types the parameter ANY. A declared hint with `nullable: false` still rejects NULL at bind (`validateParameterTypes` in `core/statement.ts`, unchanged).
- **LIMIT / OFFSET prepare check (`planner/building/row-count-expression.ts`).** A nullable LIMIT / OFFSET expression is accepted at prepare when a discarded copy of it, rebuilt with every nullable parameter made non-null (and an ANY parameter assumed INTEGER), is non-null. The plan keeps the parameters' real nullable types; NULL is caught by the runtime `toRowCount` check before any source row is read. Scalar subqueries are not descended.
- **`ScalarFunctionCallNode.withChildren` (`planner/nodes/function.ts`)** re-runs `inferReturnType` on the new operands via the shared helper `inferScalarCallType` (also used by `building/function-call.ts`). A schema without `inferReturnType` keeps the node's explicit type (the materialized-view rewrite's synthetic `agg_combine`).
- **Docs:** `docs/types-parameters.md` (inference rules, "A first binding of `null`", NULL-compatibility bullet) and `docs/sql-select.md` §3.6 "Valid row counts".

## Review findings

**Read:** the full implement diff (source, tests, docs), `ParameterReferenceNode`, `Statement.compile` / `getColumnDefs` / `validateParameterTypes`, the other `ScalarFunctionCallNode` construction site (`rules/cache/rule-materialized-view-rewrite.ts`), planner/analysis consumers of `.nullable` (`change-scope.ts` portable parameter types, key-filter, coverage prover, join rules), and every doc hit for parameter nullability.

**Probed by running** (temporary spec, deleted): ~24 LIMIT shapes executed with bound values. Results match the docs: `limit ?`, `? + 1`, `? * 2`, `cast(? as integer)`, `abs(?)`, `round(?)`, `coalesce(?, null)`, `case when ? then 1 else 2 end`, `? between 1 and 2`, `:a + :a`, `? collate nocase`, `? offset ?` all prepare and run; `? / 2`, `? % 2`, `nullif(?, 0)`, `? in (1, 2)`, `json_array_length(?)`, `(select ?)`, `(select null)` are rejected at prepare; `-?` bound to 2 fails at execution as negative. Also checked `where k = ?` still plans as an index seek on the primary key, and `select ? as v` prepared with `[5]` now announces a nullable INTEGER (intended).

**Correctness — no defects found in the change.** The copy built by `withParametersAssumedNonNull` is discarded, and `ParameterReferenceNode` construction has no side effects beyond a node id. `withChildren` re-inference only narrows or corrects types against the actual operands; the one explicit-type construction site has no `inferReturnType`, so it keeps its type. The implementer's ANY → INTEGER assumption is accepted as written: it is the only way `limit ? + 1` on an unbound parameter prepares (`BinaryOpNode` announces ANY arithmetic nullable), it is documented in §3.6, and a wrong guess only moves a NULL / non-numeric failure to execution, where `toRowCount` rejects it.

**Tests.** The early-stop test forces planning with `getColumnDefs()`, which swallows compile errors (`core/statement.ts`, pre-existing, commented as deliberate). The test still distinguishes: a prepare-time rejection would re-raise at `all()` as "LIMIT expression may be NULL", not the asserted "LIMIT must not be NULL". The three added tests each pin a behaviour the ticket asked for (the reproduction, a declared `nullable: false` still rejected at bind, prepare-vs-runtime split for LIMIT); none restates the implementation. No tests added or cut.

**Found elsewhere (evidence, appended):** `length(X)` announces `nullable: false` but returns NULL for a non-null non-TEXT/BLOB argument, so `limit length(?)` run with `[2]` passes the prepare check and fails at execution. Runtime catches it, no wrong result. Appended as a note to `backlog/debt-announced-nullability-disagrees-with-produced-nulls` (same class; this instance also needs the argument's logical type, not only its nullability).

**Fixed inline:** a stray double blank line after the inference paragraph in `docs/types-parameters.md`.

**DRY / modularity:** the local expression walk in `row-count-expression.ts` duplicates the shape of four other planner walks with different guards; the implementer's reason for not consolidating holds (out of scope, guards differ). No ticket — no single site, no current anchor.

**Performance / resource cleanup:** the copy is built only for a nullable LIMIT / OFFSET at plan time; `inferReturnType` per `withChildren` is a small call. Nothing to clean up.

**Plan quality:** not measured beyond the primary-key seek probe; no rule in `planner/rules` or `planner/analysis` reads a parameter's nullability for access-path choice (the `.nullable` reads are on columns or change-scope metadata). Nothing parked.

**Tripwires:** none new.

## Validation

- `yarn workspace @quereus/quereus run lint` — pass.
- `yarn workspace @quereus/quereus run test` — 11146 passing, 26 pending, 0 failing.
- Not run: `yarn test:store`, strict-mode variants.
