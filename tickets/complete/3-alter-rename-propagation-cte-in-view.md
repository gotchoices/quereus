---
description: ALTER TABLE RENAME COLUMN now propagates through CTEs in view bodies (including multi-CTE chains, select-*, and CTEs inside subqueries)
files:
  - packages/quereus/src/schema/rename-rewriter.ts
  - packages/quereus/src/parser/parser.ts
  - packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic
  - docs/sql.md
---

## Summary

`renameColumnInAst` previously only walked into CTE bodies; the *outer* SELECT
of a view body referencing a CTE that re-exposed the renamed column was left
alone, so `create view v as with c as (select k from t) select k from c`
became broken after `alter table t rename column k to kk`.

The column-rename visitor in `packages/quereus/src/schema/rename-rewriter.ts`
now tracks a per-WITH scope frame (`ctesExposingRenamed`) populated as each
CTE body is rewritten. An outer FROM-clause reference to an exposing CTE is
plugged into the scope as if it were the renamed table itself, so
unqualified/qualified column refs in the outer SELECT rewrite correctly. The
analysis recurses cleanly through nested WITHs and multi-CTE chains
(`with a as (...), b as (select k from a) select k from b`). A CTE is
classified as exposing iff it has no explicit column list and at least one
result column is a passthrough (`select k`, `select t.k`, or `select *`) of
the renamed column with no projection alias.

`packages/quereus/src/parser/parser.ts` also picked up a small but
self-contained fix: `tableSource()` did not previously recognize
`( WITH ... SELECT ... )` as a subquery source, so test case 6d
(`select * from (with c as ... select k from c) s`) wouldn't parse at all.
The lookahead now accepts WITH and `subquerySource()` consumes the WITH
clause before delegating to the inner SELECT.

`docs/sql.md` § ALTER TABLE / RENAME COLUMN was updated to describe the new
scope rules and the "CTE re-exposes column" condition.

## Tests

`packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic` covers:

- **6** — base case (CTE in view body).
- **6a** — aliased CTE projection does NOT propagate.
- **6b** — explicit CTE column list stops propagation.
- **6c** — multi-CTE chain propagates through every link.
- **6d** — CTE inside a subquery in the view body (exercises the parser fix).
- **6e** — `select *` star passthrough propagates.
- **6f** — *added in review* — qualified outer reference (`select c.k from c`)
  to an exposing CTE rewrites correctly (closes the implementer's flagged
  gap on the `aliasMap` addition for CTE names).

## Review findings

Checked: SPP/DRY/modular decomposition, scope-stack semantics, push/pop
pairing under exceptions, recursion through nested WITHs, performance,
type safety, docs accuracy, regression on neighbouring sections of 41.3,
lint, full test suite.

- **Architecture / SPP / DRY**: Helpers (`emptyFrame`, `pushWithFrame`,
  `analyzeWithFrame`, `cteExposesRenamedColumn`, `isResultColumnExposure`,
  `isCteExposingInScope`) decompose the responsibilities cleanly. INSERT /
  UPDATE / DELETE wrap their existing logic in a single `pushWithFrame`
  + `try/finally` pop, consistent with SELECT. No duplication beyond the
  mechanical try/finally pattern.

- **Scope-stack semantics**: Traced multi-CTE chain (6c), aliased
  projection (6a), explicit column list (6b), star passthrough (6e),
  subquery-with-WITH (6d), and qualified `c.k` (6f) — all behave correctly.
  The `aliasMap.set(cteName, state.tableName)` line in
  `collectFromBindings` (implementer's beyond-ticket addition) is now
  exercised by 6f.

- **Push/pop pairing**: All four `case` blocks (select/insert/update/delete)
  wrap the with-frame push in `try/finally`. UPDATE/DELETE also nest a
  target-table frame inside the with-frame, also `try/finally`-guarded.
  `analyzeWithFrame` pushes/pops within itself; `cteExposesRenamedColumn`
  pushes the returned body-with-frame and pops in `try/finally`. No
  push-without-matching-pop paths.

- **Parser fix**: The `(WITH ...) AS alias` change is minimal and
  symmetric with the existing `(SELECT ...)` and `(VALUES ...)` paths. It
  does not interfere with `(VALUES ...)` or compound-SELECT paths
  (different lookahead tokens). The `parseSchemaPath` interaction the
  implementer worried about doesn't fire here — schema-path parsing
  happens at top-level SELECT termination, not inside a parenthesized
  subquery body. **Minor inconsistency** with
  `createViewStatement`'s `selectStatement(token, innerWith ?? withClause)`
  pattern (new code uses `innerWith` only) — left as-is because the
  `withClause` thread is purely parse-time context, never inspected
  during parsing, and the AST-level `sel.withClause = innerWith`
  assignment is what the planner actually consumes.

- **Performance**: Exposure analysis is O(n × m) per WITH-clause (n CTEs,
  m result columns per CTE body), invoked once per dependent view at
  ALTER time. Trivial.

- **Type safety**: No `any` introduced. New helpers are fully typed
  against `AST.WithClause` / `AST.CommonTableExpr` / `AST.ResultColumn`.

- **Error handling / resource cleanup**: Visitor never swallows
  exceptions; pop happens in `finally`. No new failure modes that need
  reporting.

- **Docs**: `docs/sql.md` ALTER TABLE / RENAME COLUMN paragraph was stale
  (claimed only "unaliased FROM scope" — under-stated). Updated in this
  review pass to cover qualified refs, the CTE re-exposure rule, and the
  explicit-column-list exception. `docs/schema.md` line 281/295
  references are generic enough not to need changes. `docs/memory-table.md`
  is unrelated.

- **Lint**: `yarn lint` exits 0, no output.

- **Full test suite**: `yarn test` — 3098 passing, 2 pending (unrelated
  property-planner skips). Includes the original section 6 and new
  6a–6f. `yarn test:store` deferred per AGENTS.md guidance (no
  store-specific changes).

### Findings outside the ticket scope

- **CTE shadowing the renamed table** — implementer's flagged gap #1.
  This is a real correctness hole that predates these changes: when a
  CTE happens to share a name with the renamed table and the CTE itself
  doesn't re-expose the renamed column, the outer FROM still resolves
  to the *real* table and unqualified column refs get rewritten — even
  though the user clearly meant the CTE. Filed as new fix ticket
  `alter-rename-propagation-cte-shadowing-renamed-table`. The fix is
  small (track a `ctesInScope` superset alongside `ctesExposingRenamed`
  and consult it in `collectFromBindings`) but warrants its own test
  matrix and isn't blocking the current work.

- **Subquery-without-CTE inside view body** — implementer's flagged gap.
  `create view v as select k from (select k from t) s` — the existing
  visitor skips `subquerySource` in `collectFromBindings` (it's aliased),
  so the outer `select k` does not propagate. Pre-existing behavior,
  unaffected by this change, and not on the ticket. Out of scope; no
  ticket filed pending real demand.

- **Mutating CTE bodies (INSERT/UPDATE/DELETE … RETURNING in a WITH)** —
  implementer's flagged gap #5. `cteExposesRenamedColumn` returns false
  for `query.type !== 'select'`, which is consistent with treating these
  as non-passthrough. Matches project intent; no follow-up needed.

- **Recursive CTE without column list** — implementer's flagged gap #4.
  Recursive CTEs in this codebase carry a column list almost by
  construction; for the rare ones that don't, the visitor short-circuits
  on column-list-present and otherwise treats the recursive self-reference
  as a non-exposing CTE (won't crash, won't rewrite). Acceptable.

### Inline changes from the review pass

- Added test section **6f** (qualified outer ref to exposing CTE) to
  `41.3-alter-rename-propagation.sqllogic`.
- Updated `docs/sql.md` ALTER TABLE / RENAME COLUMN paragraph to
  accurately describe scope behavior, qualified refs, and CTE
  re-exposure rules.

## End
