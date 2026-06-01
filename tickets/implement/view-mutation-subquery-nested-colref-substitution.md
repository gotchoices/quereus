description: Descend into subquery / exists / in-subquery operands during view-mediated DML view-column substitution, so a view-column reference nested inside a correlated subquery in a `where` / `set` value is rewritten to its base-term lineage instead of silently re-binding to a same-named base column. Scope-aware so it neither mis-binds correlated refs nor breaks subquery-local same-named columns. Covers both the single-source spine and the multi-source join walk (shared `transformExpr`).
files: packages/quereus/src/planner/mutation/single-source.ts, packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/mutation/mutation-diagnostic.ts, packages/quereus/src/parser/ast.ts, packages/quereus/test/logic/93.4-view-mutation.sqllogic, docs/view-updateability.md

## Summary

`transformExpr` (`single-source.ts`, reused by `multi-source.ts`) rewrites view-column
references to their base-term lineage but **does not recurse into `subquery` / `exists` /
`in`-subquery operands** — its `default` arm passes them through structurally, and the
`in` arm transforms only `expr.expr` / `expr.values`, never `expr.subquery`. A view-column
reference nested inside such a subquery is left un-substituted, then re-resolved in the
lowered base statement's scope, where it can silently bind to a same-named base column
instead of the view column's true lineage — a **silent wrong write**, not a diagnostic.

## Reproduction (confirmed)

Single-source view that renames a base column (`note` := base `lbl`), over a base table
that *also* has a literal `note` column:

```sql
create table c (cid integer primary key, note text, lbl text);
create table other (k text);
insert into c values (1, 'BASE_NOTE_1', 'LBL_1'), (2, 'BASE_NOTE_2', 'LBL_2');
insert into other values ('LBL_1');
create view jv as select cid as cid, lbl as note from c;   -- view col `note` := base `lbl`

-- `note` inside EXISTS is a correlated reference to the view column (= base `lbl`).
update jv set note = 'CHANGED' where exists (select 1 from other o where o.k = note);
```

- **Expected** (substitute `note`→`lbl`): predicate is `exists(select 1 from other o where o.k = lbl)`;
  `cid=1` (lbl `LBL_1`, present in `other`) matches → its `lbl` becomes `CHANGED`.
- **Actual (buggy)**: `note` is left un-substituted; on re-plan it binds to base `c.note`
  (`BASE_NOTE_*`, absent from `other`) → the predicate matches **no** row → the update
  silently no-ops. Verified: both base rows unchanged.

(The fix-stage repro was run as a throwaway mocha spec under `Database.exec` / `Database.eval`
and removed; reconstruct it as the test cases in the TODO.)

The multi-source join walk shares the same `transformExpr` (via `substituteViewColumns`,
applied to the user WHERE that becomes the per-side identifying predicate, and to SET
values), so it inherits the identical gap by construction.

## The two opposing hazards (why a naive fix is wrong)

A purely name-based descent is **not** safe, because two cases pull in opposite directions:

1. **Correlated view reference** (the repro): `... where o.k = note` — `note` resolves to the
   *outer* view row → **must** be substituted. Status quo leaves it → silent mis-bind.
2. **Subquery-local same-named column**: `... where id in (select note from src)` where `src`
   has its own `note` column — `note` resolves *locally* to `src.note` → must **not** be
   substituted. Status quo (pass-through) is already correct here; a naive "substitute every
   view-column name" descent would *break* this case.

SQL resolves an unqualified name to the innermost scope that defines it. So the descent must
be **scope-shadowing-aware**: substitute a reference only when it is genuinely correlated to
the outer view row (the name is not introduced by any source local to the subquery), and
never touch a reference qualified by, or resolvable within, a subquery-local source.

## Design — scope-aware descent (recommended / target)

Concentrate the view-specific scope logic in the mutation module; keep the generic
`transformExpr` / `cloneExpr` shape intact and non-breaking.

### 1. Add a `descend` hook to `transformExpr`

Extend the signature with an optional inner-query transformer:

```ts
export function transformExpr(
  expr: AST.Expression,
  substitute: (col: AST.ColumnExpr) => AST.Expression | undefined,
  descend?: (query: AST.QueryExpr) => AST.QueryExpr,
): AST.Expression
```

- `subquery` arm: `{ ...expr, query: descend ? descend(expr.query) : expr.query }`
- `exists` arm: `{ ...expr, subquery: descend ? descend(expr.subquery) : expr.subquery }`
- `in` arm: also thread the subquery — `subquery: expr.subquery && descend ? descend(expr.subquery) : expr.subquery`
  (currently the `in` arm rewrites `expr` / `values` but drops `subquery` entirely).

With `descend` omitted the behavior is byte-identical to today, so `cloneExpr` (which calls
`transformExpr(expr, () => undefined)`) and every other existing caller are unchanged.

### 2. `transformQueryExpr` — the scope-aware inner-query walker (mutation module)

Add a helper (shared by both spines; likely in `single-source.ts`, exported, or a small new
`view-subquery.ts` imported by both) that transforms an inner `QueryExpr`, threading the set
of column names shadowed by enclosing subquery scopes:

```ts
function transformQueryExpr(
  ctx: PlanningContext,
  query: AST.QueryExpr,
  columnMap: ReadonlyMap<string, AST.Expression>,  // view-col (lc) -> base-term expr
  viewName: string,
  shadowed: ReadonlySet<string>,                   // names introduced by enclosing inner scopes
): AST.QueryExpr
```

For a `SelectStmt`:
- Compute `localNames = collectFromColumnNames(ctx, sel.from)` — the column names this
  select's own FROM introduces (see step 3). The shadow set for references in *this* select's
  clauses is `shadowed ∪ localNames`.
- Build a scope-aware substitute closure:
  - **qualified by the view name** (`viewName`) → substitute via `columnMap` (it is
    unambiguously a view-output reference);
  - **unqualified** and **name ∈ columnMap** and **name ∉ shadow set** → correlated to the
    outer view row → substitute;
  - otherwise (qualified by any other alias, or a name a local source defines) → leave.
- Transform every embedded scalar expression with that substitute and a `descend` that
  recurses via `transformQueryExpr(ctx, q, columnMap, viewName, shadowed ∪ localNames)`:
  `columns` (each `ResultColumnExpr.expr`), `where`, `having`, `groupBy[]`, `orderBy[].expr`,
  `limit`, `offset`, and join `condition`s in `from` (and any `SubquerySource.subquery`
  inside `from`, recursed the same way). Preserve `compound` / `union` legs by recursing into
  their `QueryExpr` too.

For a `ValuesStmt`: transform each value expression with the substitute (no FROM, so no new
shadowing — value rows are evaluated in the correlating outer scope).

For a DML `QueryExpr` (INSERT/UPDATE/DELETE with RETURNING) embedded as a subquery: rare;
reject with a structured diagnostic (see step 4) rather than attempt a partial rewrite.

### 3. `collectFromColumnNames(ctx, from)`

Resolve the set of lowercased column names introduced by a subquery's FROM sources:
- `table` source → `ctx.schemaManager.getTable(schema, name)?.columns` (also views / MVs if a
  read-source — use the same lookups the planner uses). The alias does not add column *names*;
  qualified refs to a local alias are handled by the qualifier rule in step 2 (only the view
  name and bare names are ever substituted).
- `subquerySource` → its explicit `columns` override, else its projection's output names
  (recurse for nested selects).
- `join` → union of both sides.
- `functionSource` (TVF) → its declared output columns when statically known.

If a source's columns **cannot be confidently determined** (e.g. `select *` over a source we
won't resolve here, or a TVF with dynamic columns), do **not** guess — raise the conservative
reject diagnostic (step 4). Resolving plain base tables (the overwhelmingly common case, incl.
the repro) is sufficient to fix the reported corruption; the conservative reject keeps the
unresolved tail honest instead of silently mis-binding.

### 4. Conservative reject diagnostic

Add a reason to `MutationDiagnosticReason` in `mutation-diagnostic.ts`, e.g.
`unsupported-subquery-correlation`, raised when the descent cannot prove whether a nested
reference is correlated (unresolvable subquery source / `select *` / TVF / embedded DML). The
message should name the view and point the user at qualifying the reference or restructuring
the predicate. This converts the residual unanalyzable tail from **silent corruption** to a
**loud, structured error** — the safe-minimum contract from the source ticket, applied only
where scope-aware descent genuinely cannot decide.

### 5. Wire both spines

- **single-source** (`rewriteViewUpdate` / `rewriteViewDelete`): the top-level `transformExpr`
  calls on `stmt.where` / `asg.value` pass a `descend` built from `analysis.columnMap`,
  `view.name`, and `ctx`, with an initial empty shadow set. The top-level WHERE/SET themselves
  keep the existing `remapper` (qualifier-blind is fine at top level — single base source), but
  the `descend` they thread uses the scope-aware substitute described above.
- **multi-source** (`substituteViewColumns`): thread the same `descend` (built from
  `viewColToBaseRef`, `view.name`, `ctx`) into its `transformExpr` call. Note the multi-source
  base-term replacements are alias-qualified (`p.label`); they correlate correctly to the join
  body that becomes the FROM of the generated identifying subquery. `substituteViewColumns`
  needs a `ctx` parameter (thread it from `analyzeJoinView` / the `decompose*` callers).

### Deep-clone note

`cloneExpr` currently shallow-clones subquery operands (`{ ...expr }` shares the inner
`QueryExpr` object). The descent must produce *fresh* inner query nodes (it already rebuilds
them), so substituted subqueries don't alias the view body's AST. Multi-source's existing
`cloneFromClause` deep-clones the join body separately; keep that. Audit that the body-WHERE
clone in `buildIdentifyingPredicate` (`cloneExpr(analysis.sel.where)`) doesn't leave shared
subquery nodes if the body WHERE itself embeds a subquery — deep-clone if so.

## Alternative (fallback if scope-aware descent proves too costly)

Pure **reject**: detect any `subquery` / `exists` / `in`-subquery operand within the DML
predicate / SET value that *could* reference a view column (conservatively: contains any
unqualified or view-qualified column reference whose name is in `columnMap`), and raise the
`unsupported-subquery-correlation` diagnostic. This is the safe minimum (no silent
corruption) but regresses capability: subqueries that legitimately reference a view column
correlatedly (the repro) would error instead of working, and care is needed not to reject
subqueries that touch *no* view column (those work today and must keep working). Prefer the
scope-aware descent; fall back to this only if source resolution at the AST layer proves
unworkable.

## Notes / references

- `transformExpr` / `cloneExpr` / `combineAnd`: `single-source.ts:95-159`.
- single-source rewrite entry points: `rewriteViewUpdate` (`single-source.ts:463`),
  `rewriteViewDelete` (`single-source.ts:489`); `remapper` (`single-source.ts:368`).
- multi-source `substituteViewColumns` (`multi-source.ts:579`), `buildIdentifyingPredicate`
  (`multi-source.ts:544`), `stripSideQualifier` (`multi-source.ts:597`).
- AST: `SubqueryExpr.query`, `ExistsExpr.subquery`, `InExpr.subquery`, `SelectStmt`,
  `SubquerySource`, `QueryExpr` (`ast.ts:129-281, 419-424`).
- Diagnostics surface: `mutation-diagnostic.ts`.
- Docs to update: `docs/view-updateability.md` — the "Subqueries are passed through
  un-rewritten" Phase-1 limitation note(s), and the doc-comments in `single-source.ts`
  (`transformExpr` JSDoc lines 100-105, `normalizeBaseRefs` lines 161-174) that currently
  state subqueries are not descended into.

## TODO

- Extend `transformExpr` with the optional `descend` hook; thread it through the `subquery` /
  `exists` / `in` arms (and add `in.subquery` handling). Confirm `cloneExpr` and all existing
  callers are unchanged with `descend` omitted.
- Add `collectFromColumnNames(ctx, from)` resolving local column names from FROM sources
  (base tables via `ctx.schemaManager`; subquery sources via projection/`columns`; joins via
  union; conservative-unknown → signal reject).
- Add `transformQueryExpr(ctx, query, columnMap, viewName, shadowed)` implementing the
  scope-aware substitute + recursive `descend`, covering SelectStmt clauses (columns / where /
  having / groupBy / orderBy / limit / offset / join conditions / nested subquery sources /
  compound legs) and ValuesStmt.
- Add the `unsupported-subquery-correlation` reason to `MutationDiagnosticReason` and raise it
  on the conservative-unanalyzable tail (and embedded-DML subqueries).
- Wire `descend` into single-source `rewriteViewUpdate` / `rewriteViewDelete` (and any other
  `transformExpr` call that processes user predicates / values, incl. INSERT source if a
  subquery can appear there).
- Add `ctx` to `substituteViewColumns` and wire `descend` in multi-source; verify the
  alias-qualified base-term replacements correlate correctly inside the generated identifying
  subquery.
- Audit `cloneExpr` shallow subquery sharing on the descent paths; deep-clone inner queries
  where a substituted subquery would otherwise alias the view body's AST.
- Tests (`test/logic/93.4-view-mutation.sqllogic`): add cases for
  (a) the repro — correlated view-col ref inside `exists` → correct base-term substitution
      (assert the *write happens* on the renamed base column, the silent-no-op is gone);
  (b) view-col ref inside an `in (select ... where ...)` correlated predicate;
  (c) subquery-local same-named column (`in (select note from src)` where `src.note` exists)
      → **not** substituted (no regression);
  (d) a subquery referencing no view column at all → still works unchanged;
  (e) multi-source join view: a view-col ref nested in a subquery in the user WHERE / a SET
      value → routed to the correct base term;
  (f) the conservative reject path (`select *` / TVF subquery source that can't be resolved)
      → structured `unsupported-subquery-correlation` error.
  Consider also extending the `View Round-Trip Laws` PutGet block in `test/property.spec.ts`
  if a subquery-bearing view body is in scope there.
- Run `yarn workspace @quereus/quereus test` (stream with `tee`) and `yarn workspace
  @quereus/quereus lint` (single-quote globs on Windows); fix fallout.
- Update `docs/view-updateability.md` and the stale `single-source.ts` doc-comments to state
  subqueries are now descended into (scope-aware), with the conservative reject as the
  documented residual.
