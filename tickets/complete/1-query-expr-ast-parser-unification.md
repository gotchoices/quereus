---
description: Orthogonal QueryExpr surface — SELECT / VALUES / DML-with-RETURNING accepted at every relation site. Single unified AST + parser entry point (`parseQueryExpr`), unified `SubquerySource` (mutatingSubquerySource collapsed in), unified emitter dispatch via `astToString`. Top-level VALUES picks up trailing compound chains and ORDER BY / LIMIT / OFFSET through a synthesized SELECT-from-(VALUES) wrapper. Planner gates DML at every non-INSERT-source non-FROM-subquery relation position pending the follow-up `dml-in-expression-position` ticket.
files:
  - packages/quereus/src/parser/ast.ts
  - packages/quereus/src/parser/parser.ts
  - packages/quereus/src/parser/visitor.ts
  - packages/quereus/src/emit/ast-stringify.ts
  - packages/quereus/src/schema/rename-rewriter.ts
  - packages/quereus/src/schema/view.ts
  - packages/quereus/src/util/mutation-statement.ts
  - packages/quereus/src/runtime/emit/alter-table.ts
  - packages/quereus/src/planner/nodes/create-view-node.ts
  - packages/quereus/src/planner/analysis/assertion-classifier.ts
  - packages/quereus/src/planner/building/insert.ts
  - packages/quereus/src/planner/building/select.ts
  - packages/quereus/src/planner/building/select-compound.ts
  - packages/quereus/src/planner/building/with.ts
  - packages/quereus/src/planner/building/create-view.ts
  - packages/quereus/src/planner/building/expression.ts
  - packages/quereus/test/logic/01.9-query-expr-values.sqllogic
  - packages/quereus/test/logic/01.9-query-expr-dml-gates.sqllogic
  - docs/sql.md
  - docs/architecture.md
---

## Outcome

Landed the orthogonal QueryExpr surface in both AST and parser. `MutatingSubquerySource` is gone; `SubquerySource.subquery` widened to `QueryExpr`. Every relation site reads the same five forms (`SELECT | VALUES | INSERT/UPDATE/DELETE [RETURNING]`). Parser-side gate enforces RETURNING-required at non-top-level positions; planner-side gate refuses DML at scalar / IN / EXISTS / compound-leg / view-body / non-top CTE-body / INSERT-source positions with a single "track ticket `dml-in-expression-position`" error class.

Build, lint, and the full `yarn test` suite (3649 passing) are green at HEAD.

## Review findings

Reviewed the implement commit `b5fb50dfa3d73b136459d25f47cb92334e3f3229` fresh against the diff before reading the handoff. Categories checked: parser correctness (with adversarial probing of the bespoke `valuesStatementWithOptionalCompound` / `continueSelectAfterFrom` pair), AST shape and `QueryExpr` widening, planner gate placement (six sites), emitter symmetry (`astToString` dispatch on every QueryExpr type), schema rewriter cases, view-body planning, recursive-CTE base / recursive leg extraction, test coverage (logic + spec), docs (sql.md, architecture.md), lint, full test suite. Aspect lens: SPP, DRY, type safety, error handling, resource cleanup, performance.

### Minor — fixed inline

- **`valuesStatementWithOptionalCompound` did not synthesize a wrapper for top-level / subquery / CTE bare-VALUES with ORDER BY / LIMIT / OFFSET, contrary to the helper's own docstring claim "VALUES … ORDER BY … LIMIT … is also picked up here".** The condition only checked for compound operators; ORDER BY / LIMIT-only cases fell through as bare `ValuesStmt` and the trailing tokens raised a statement-boundary parse error. Affected:
  - `values (1) order by 1`
  - `values (1) limit 1`
  - `select * from (values (1), (2) order by column_0) as v`
  - `with c(a) as (values (3), (1), (2) order by column_0) select * from c`

  Fix at `packages/quereus/src/parser/parser.ts`: expanded `valuesStatementWithOptionalCompound` to wrap whenever any of compound / ORDER BY / LIMIT follows, and threaded an `isCompoundSubquery` flag through `valuesStatementWithOptionalCompound` and `continueSelectAfterFrom` so right-leg position correctly suppresses ORDER BY / LIMIT consumption (those belong to the outer compound).

- **Three-or-more-leg compound chains involving a VALUES right leg failed at the second `UNION`.** A `SELECT … UNION VALUES (…) UNION SELECT …` or `VALUES (1) UNION VALUES (2) UNION VALUES (3)` parsed the first two legs and then errored at the trailing `UNION` because the VALUES right-leg branch called the bare `valuesStatement` (which returns a `ValuesStmt`, and `ValuesStmt` has no `compound` field), and never recursed into the chain. SELECT legs hadn't hit this because they recurse through `selectStatement(..., isCompoundSubquery=true)`, which itself parses a further compound.

  Fix: the VALUES right-leg branch in both `selectStatement` and `continueSelectAfterFrom` now calls `valuesStatementWithOptionalCompound(legStartToken, withClause, /*isCompoundSubquery*/ true)` — recursive synthesis chains further compounds via successive SELECT-from-(VALUES) wrappers, structurally identical to a user-written nesting.

- **Defensive WHERE / GROUP BY / HAVING consumption removed from `continueSelectAfterFrom`.** The implementer parsed these "defensively so users aren't surprised", but bare VALUES does not accept WHERE / GROUP BY / HAVING under any common SQL dialect, and silently absorbing those tokens converts a user typo into a planner-time surprise. Removed; the tokens now error at the statement boundary, same as before unification.

- **Logic test pinning at `packages/quereus/test/logic/01.9-query-expr-values.sqllogic`:** added cases 9–13 covering three-leg VALUES UNION chains, bare-VALUES ORDER BY / LIMIT / OFFSET at top level, ORDER BY inside a parenthesized subquery source, and ORDER BY inside a CTE body. The first eight cases pinned by the implementer are unchanged.

### Major — filed as follow-up tickets

None. The two parser correctness gaps above were small enough to land in-pass; the property-suite coverage gap below is a documented backlog item, not a bug.

### Coverage gap — filed as backlog

- **AST round-trip property suite covers `queryExprArb` only at the CREATE VIEW body.** IN / EXISTS / scalar-subquery / compound-leg / non-view-body CTE sites still drive `simpleSelectArb` only. The `*.sqllogic` corpus pins those execution paths positively but the round-trip is the catch for "stringifier silently drops a field"; a regression at one of those emitter sites would not surface through fast-check today. Filed as `tickets/backlog/query-expr-roundtrip-property-coverage.md`.

### Verified — no findings

- **Planning-time DML gate placement at the six sites** (SubqueryExpr, ExistsExpr, InExpr, compound right leg, view body, non-top CTE body) plus the INSERT-source gate in `insert.ts`. Site labels in the error message are distinct (`"scalar subquery"` / `"IN subquery"` / `"EXISTS subquery"` / `"as a compound set-operation leg"` / `"as a view body"` / `"CTE bodies"`) so the gate location is identifiable from the error alone. CREATE VIEW now plans the body even with no explicit column list so DML bodies fail at CREATE VIEW time, not at first reference. Confirmed via `01.9-query-expr-dml-gates.sqllogic`.

- **Parser-side RETURNING-required gate** at non-top-level positions (CTE body, FROM subquery, scalar / IN / EXISTS subquery, compound leg, view body, INSERT source). Fires before the planner gate, with a uniform error message. Pinned in `01.9-query-expr-dml-gates.sqllogic`.

- **Recursive-CTE base/recursive leg extraction.** The recursive leg type guard now lives explicitly in `with.ts` and throws a clear error if the user writes a non-SELECT recursive leg (`UNION ALL VALUES …` or DML). Base case construction (`{ ...selectStmt, compound: undefined, … }`) is type-narrowed correctly. Existing recursive-CTE logic tests still pass.

- **`assertion-classifier.ts` narrowing.** The classifier bails out on any non-SELECT EXISTS body. Logic tests in 13.4 / 28.1 / 44 etc. pass without change.

- **Emitter symmetry.** `astToString` dispatches on every QueryExpr discriminator (`select / insert / update / delete / values`). All emitter call sites at QueryExpr-accepting positions (`fromClauseToString.subquerySource`, `insertToString.source`, `selectToString.compound`, `expressionToString` cases for `subquery / exists / in`, `createViewToString.select`, `declaredViewToString.select`) route through `astToString`. The CREATE-VIEW round-trip property suite generates VALUES-bodied views and they survive parse → stringify → parse.

- **Schema rewriters (`rename-rewriter.ts`).** Both `visitTableRename` and `visitColumnRename` walk `insert.source` (was `values + select`) and rely on the unified `subquerySource.subquery` case. `collectFromBindings` correctly groups `subquerySource` with `functionSource` (aliased; doesn't expose the renamed underlying table for unqualified resolution). No double-walks or missed branches.

- **`util/mutation-statement.ts` and `runtime/emit/alter-table.ts`** rebuild and emit through the unified shape (`source: { type: 'values', … }`, `astToString(view.selectAst)`). View-body SQL re-derivation after table/column rename works under the new shape.

- **Synthesized aliases (`values_<offset>`, `subquery_<offset>`, `mutating_subquery_<offset>`)** are FROM-clause aliases scoped to the synthesized SELECT-from-(VALUES) wrapper, not exposed at any outer scope. A user table named `values_0` does not collide (verified at the parser by attempting `select * from values_0`).

- **Lint, build, full `yarn test` (3649 passing, 0 failing, 9 pending).** Quereus package and repo workspaces green.

- **`yarn test:store` was not run** — the change set is store-agnostic (AST + parser + planner builders, all upstream of vtab dispatch) and the package-level `yarn test` exercises the memory vtab path. Listed for completeness, not flagged.

### Out of scope (per the implement ticket)

- `hasSideEffects` audit, optimizer-rule audit, runtime-emitter changes → `query-expr-side-effect-audit`.
- Lifting the planning-time DML-in-expression-position gate (full-drain, run-once fence, change-scope propagation, view-body rejection) → `dml-in-expression-position`.
- Parallel-track refusal of impure branches → `query-expr-parallel-track-refusal`.
- One-indexed `column1` synthesized naming → backlog if desired.
- `TABLE t` shorthand and lateral `VALUES` cases → backlog.
