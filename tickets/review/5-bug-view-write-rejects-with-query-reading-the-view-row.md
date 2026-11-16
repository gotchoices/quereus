description: Writing through a view now handles a WITH query that reads the row being written — both when the view's own filter contains one (it used to fail with "column not found") and when the UPDATE's own WHERE contains one naming a renamed view column (it used to silently change the wrong rows).
architecture: docs/view-updateability.md
files:
  - packages/quereus/src/planner/mutation/scope-transform.ts  # rebuildSelect (new onCte param), cloneWithClause, mapQueryExprUniform, mapNestedSelects, transformScopedQuery, transformAliasScopedQuery
  - packages/quereus/src/planner/building/view-mutation-builder.ts  # comment only (~line 136)
  - packages/quereus/test/logic/93.4-view-mutation.sqllogic   # two regression blocks appended at the end
  - docs/view-updateability.md                                # § Schema resolution during write-through
----

## What changed

A write through a view is lowered to a write on the base table, and column references inside copied subqueries are rewritten on the way. That rewrite used to stop at a nested select's `with` clause: CTE bodies were cloned verbatim on the (false) premise that a CTE body cannot read the enclosing row. Now `rebuildSelect` takes an `onCte` transformer for CTE bodies (default `cloneQueryExpr`), passed through `cloneWithClause`:

- `transformScopedQuery` and `transformAliasScopedQuery` pass their `onLeg` — a CTE body has a sibling compound leg's scope: it sees the enclosing scope (incoming shadow set, taint, alias set) but not this select's FROM, and is planned on this select's environment (`fromCtx`, matching `buildSelectStmt`'s `contextWithSchemaPath`).
- `mapQueryExprUniform` passes its `descend` (qualifier-only substitutions are correct at any depth, so `substituteNewRefs` now also replaces `new.x` inside a WITH body).
- `mapNestedSelects` passes `cloneQueryExpr` explicitly — CTE bodies stay unstamped on purpose (unchanged behaviour).

The three comments asserting "a CTE body cannot correlate" were corrected; a `NOTE:` at the hand-off in `transformScopedQuery` records the sibling-CTE taint consequence (below). Docs gained a paragraph in the static-analysis section; the "cloned unstamped" sentence now names `mapNestedSelects` instead of `rebuildSelect`.

## Tests added

Both appended to `test/logic/93.4-view-mutation.sqllogic`, fresh table names (`wq_*`, `wr_*`):

- **View filter WITH body** (`wqv`): `where (with c as (select wq_b.x as y from wq_u) select max(y) from c) > 0`; `update wqv set x = 100` changes only row 1. Without the fix this fails with `wq_b.x isn't a column` (checked by reverse-applying the source change).
- **Renamed view column inside the UPDATE's own WITH body** (`wrv`, `y as x`): `update wrv set x = 100 where exists (with c as (select x as q from wr_u) select 1 from c where q > 0)` writes row 2's `y`, not row 1. (The ticket verified the pre-fix wrong-row write; the file aborted at the first block when I reverse-applied, so I did not re-observe this one separately.)

## Validation

- `yarn test` (root): all workspaces passing, 0 failures (quereus: 11194 passing).
- `yarn lint` (root): clean.

## For the reviewer — things worth probing

- **Sibling-CTE taint (accepted consequence, NOTE in code):** a CTE body whose FROM names a sibling CTE (or itself, recursively) does not resolve in `collectFromColumnNames`, so its scope is tainted; under `makeViewScope` a bare view-column-named reference there is now rejected with `unsupported-subquery-correlation` instead of being left alone (and possibly mis-bound). The select that reads a CTE already behaved this way. Not covered by a test.
- **`'reject'`-policy scopes** (`makeBaseQualifyScope` in single-source.ts, `makeSideQualifyScope` in multi-source.ts — lineage terms of computed view columns): CTE bodies are now analysed there too. A sibling-CTE-reading CTE body now rejects the whole lineage term; in practice the select that reads the CTE was already rejected under that policy, so I expect no reachable regression — but unverified by a dedicated test.
- **`viewColumnReadSides`** (multi-source.ts ~line 3160) observes refs via `mapQueryExprUniform`, so it now also sees refs inside CTE bodies of a computed column's lineage. That can only add sides (more conservative cross-source rejection), never remove them.
- **`composeBody`** (cte-flatten.ts) uses `transformAliasScopedQuery`; a `sourceName.`-qualified ref inside a nested WITH body is now rewritten to the inner CTE's defining term like any other nested ref. Believed correct; no dedicated test.
- DELETE-through-view with the same shapes was not separately tested (same lowering path).
- Untouched, by design: `schema/expr-scope/walk.ts` and `docs/sql-ddl.md` make the same "CTE body cannot correlate" claim for CHECK constraints — a separate, documented rule. `bug-cte-shadow-precedence-scope-transform` (fix/) touches `tableSourceColumnNames` in the same file; no ordering dependency.
