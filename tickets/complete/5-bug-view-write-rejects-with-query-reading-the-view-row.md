description: Writing through a view now handles a WITH query that reads the row being written — both when the view's own filter contains one (it used to fail with "column not found") and when the UPDATE's own WHERE contains one naming a renamed view column (it used to silently change the wrong rows). Chained and recursive WITH queries inside such a write keep working too.
architecture: docs/view-updateability.md
files:
  - packages/quereus/src/planner/mutation/scope-transform.ts  # rebuildSelect/cloneWithClause (onCte), withClauseCteScopes, tableSourceColumnNames, transformScopedQuery
  - packages/quereus/src/planner/building/view-mutation-builder.ts  # comment only
  - packages/quereus/test/logic/93.4-view-mutation.sqllogic   # three regression blocks at the end
  - docs/view-updateability.md                                # § Schema resolution during write-through
----

## What landed

A write through a view is lowered to a write on the base table, and column references inside copied subqueries are rewritten on the way. That rewrite used to stop at a nested select's `with` clause, copying CTE bodies untouched on the false premise that a CTE body cannot read the enclosing row. The implement pass (`ticket(implement): bug-view-write-rejects-with-query-reading-the-view-row`) made `rebuildSelect` take an `onCte` transformer for CTE bodies:

- `transformScopedQuery` / `transformAliasScopedQuery` give a CTE body a sibling compound leg's scope (enclosing shadow set, taint and alias set; not the select's own FROM), on the select's environment.
- `mapQueryExprUniform` descends into CTE bodies (so `new.x` substitution reaches them).
- `mapNestedSelects` still clones CTE bodies unstamped, on purpose.

The review pass added static resolution of `with`-clause names (below).

## Review findings

**Read first:** the implement diff, then the handoff. Probed by script against the engine: DELETE through a view whose filter has a WITH body (correct row deleted), a join view with a WITH body in its filter (correct row updated), a view-name-qualified reference (`v.x`) inside a WITH body in the UPDATE's WHERE (rewritten to the base term), a CTE body whose own FROM has a same-named column (stays local).

**Major, fixed inline — regression from the implement pass.** Once the analysis descended into CTE bodies, a body reading an earlier sibling CTE, or itself recursively, could not resolve that name (the static pass had no view of the `with` clause), so it tainted its scope and a bare reference matching a view column name was rejected. Before the implement pass those bodies were copied untouched and worked. Reproduced against the implement commit: `update v set x = 10 where id in (with a as (select id from o), c as (select id from a) select * from c)` and the recursive `with recursive r(id) as (select 2 union all select id + 1 from r where id < 2) select r.id from r` both failed with `unsupported-subquery-correlation`; both succeed on the parent commit. Fix: `withClauseCteScopes` (scope-transform.ts) computes, per `with` clause the descent meets, which definitions each part sees — mirroring `buildWithClause` / `buildCommonTableExpr`: the select, its sub-queries and compound legs see every member; member *i*'s body sees members before it, plus itself when recursive (`isRecursiveCte`). A definition's columns are its declared list, else its projection names (`null` → taint, as before). `tableSourceColumnNames` checks this map first for an unqualified name, matching `buildFrom`'s CTE-before-catalog order. Re-entering a stored body's environment drops the enclosing definitions, as `storedBodyContext` drops `cteNodes`. The implementer's `NOTE:` about the sibling-CTE taint was removed (no longer true). Regression block added to `93.4-view-mutation.sqllogic` (`wc_*` tables): chained sibling, recursive, and a sibling-reading body whose bare `x` is *not* a column of the sibling and so still reaches the renamed view column. Confirmed it fails against the implement commit.

**Tests:** the implementer's two blocks each reproduce a distinct reported defect; kept. No tests cut.

**Docs:** `docs/view-updateability.md` paragraph rewritten to describe the `with`-name resolution instead of the old taint limitation. `view-mutation-builder.ts` comment checked and accurate.

**Other implementer probe points:**
- `'reject'`-policy scopes (lineage terms of computed view columns): a sibling-reading CTE body now resolves rather than rejecting, so the concern the handoff raised is mostly retired; no further change.
- `viewColumnReadSides` (multi-source.ts) seeing more refs: can only add sides (more conservative). No action.
- `composeBody` (cte-flatten.ts) rewriting `sourceName.`-qualified refs inside a nested WITH body: consistent with every other nested ref; not separately tested — no defect found by reading.

**Not changed, noted:** `schema/expr-scope/walk.ts` and `docs/sql-ddl.md` say a CTE body "cannot correlate to the written row" for CHECK constraints. Probed: a bare `b` inside a CHECK's WITH body does read the written row; only the qualified `t.b` spelling fails ("t.b isn't a column"), which is what the doc's sentence actually describes. The wording in `walk.ts` overstates it, but the documented behaviour matches; separate subsystem, left alone.

**Remaining gap, unchanged by this ticket:** the precedence mismatch between `ctx.cteNodes` and the catalog in `tableSourceColumnNames` stays with `bug-cte-shadow-precedence-scope-transform` (fix/). The new local-`with` lookup already uses CTE-first order, so that ticket only needs to move the `cteNodes` branch.

**Empty categories:** resource cleanup / error handling — none involved (pure AST rewriting, no new throw sites). Performance — one small map copy per `with` member per analysed select; `with` clauses in write predicates are tiny. Type safety — new `CteColumnScope` type; lint (eslint + test tsc) clean.

**Validation:** `yarn workspace @quereus/quereus run lint` clean. The quereus Mocha suite, run in three parts because one run exceeds the 10-minute tool limit: `test/logic.spec.ts` 391 passing; view/lens/mutation/CTE/scope specs plus `test/planner/**` 1763 passing; every other spec 9893 passing, 26 pending, 0 failing. Other workspaces were not re-run: the change touches only `packages/quereus/src`, and those packages test against its built output.
