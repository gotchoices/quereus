description: Review the scope-aware descent that rewrites a view-column reference nested inside a `subquery` / `exists` / `in`-subquery operand of a view-mediated DML predicate / SET value to its base-term lineage (fixing a silent wrong write), with a conservative `unsupported-subquery-correlation` reject for the unanalyzable tail. Covers both the single-source spine and the multi-source join walk.
files: packages/quereus/src/planner/mutation/single-source.ts, packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/mutation/mutation-diagnostic.ts, packages/quereus/test/logic/93.4-view-mutation.sqllogic, docs/view-updateability.md

## What shipped

`transformExpr` previously did **not** recurse into `subquery` / `exists` /
`in`-subquery operands — a view-column reference nested inside such a subquery in
a user `where` / `set` value was left un-substituted, then re-resolved in the
lowered base statement's scope where it could silently re-bind to a same-named
base column (a **silent wrong write**). This is now fixed, scope-aware, on both
the single-source spine and the multi-source join walk (which share
`transformExpr` / the new descent).

### Changes

- **`transformExpr` gains an optional `descend` hook** (`single-source.ts`).
  Added explicit `subquery` / `exists` arms and threaded `in.subquery` (the `in`
  arm previously dropped the subquery operand entirely on rewrite). With `descend`
  omitted the result is **byte-identical** to before — every existing caller
  (`decomposition.ts`, `lens-enforcement.ts`, `normalizeBaseRefs`, the top-level
  remappers) is unchanged. Verified: full suite green, no behavioural diff.

- **`cloneExpr` now deep-clones subqueries** via the new `cloneQueryExpr` /
  `mapQueryExprUniform` (it passes `cloneQueryExpr` as `descend`). This resolves
  the ticket's deep-clone audit note: the multi-source `buildIdentifyingPredicate`
  body-WHERE clone (`cloneExpr(analysis.sel.where)`) and the two sides' identifying
  subqueries no longer share inner-query AST nodes when the body WHERE embeds a
  subquery. Strictly safer (clone ⇒ independence); no behaviour change.

- **`transformQueryExpr` (scope-aware inner-query walker)** + helpers
  (`collectFromColumnNames` / `fromSourceColumnNames` / `tableSourceColumnNames` /
  `projectionOutputNames`, plus `makeViewSubstitute` / `makeViewColumnDescend`) in
  `single-source.ts`. It threads two pieces of state down through nested scopes:
  - `shadowed` — column names introduced by **enclosing** subquery scopes; a name
    a local source defines shadows the outer view column and is left untouched.
  - `tainted` — set once a scope's local column names can't be resolved statically
    (`select *` subquery source / TVF / unknown name e.g. a CTE). In a tainted
    scope an unqualified view-column-named reference can't be proven correlated, so
    it is **rejected** with the new `unsupported-subquery-correlation` diagnostic
    rather than silently mis-bound.
  Substitution fires only for a reference **qualified by the view name**, or
  **unqualified + a known view column + not shadowed** (correlated to the outer
  view row). Base-alias-qualified refs and subquery-local same-named columns are
  left alone. Compound/union legs are walked as *siblings* (same outer scope, not
  this select's FROM); nested FROM subquery sources inherit this select's FROM.

- **Diagnostic** `unsupported-subquery-correlation` added to
  `MutationDiagnosticReason` (`mutation-diagnostic.ts`).

- **Wiring.** single-source `rewriteViewUpdate` / `rewriteViewDelete` build a
  `descend` from `analysis.columnMap` / `view.name` and thread it into the
  `transformExpr` calls on `stmt.where` / `asg.value`. multi-source
  `substituteViewColumns` gained a `ctx` param and threads the same descent
  (base-term replacements there are alias-qualified `p.label`, correlating to the
  join body that becomes the identifying subquery's FROM); `ctx` flows from
  `propagateMultiSource` → `decomposeUpdate` / `decomposeDelete` →
  `buildIdentifyingPredicate`. `stripSideQualifier` now also threads a
  (qualifier-based, scope-independent) descent so a view-column ref nested in a
  multi-source SET-value subquery has its owning-side alias stripped correctly.

- **INSERT** is intentionally **not** descended: an insert source supplies values
  for base columns and has no outer-view-row to correlate to, so no view-column
  substitution semantics apply (the source is threaded through to the base insert
  unchanged, as before).

## Validation done

- `yarn workspace @quereus/quereus typecheck` — clean.
- `yarn workspace @quereus/quereus test` — **4163 passing, 9 pending, 0 failing**.
- `yarn workspace @quereus/quereus lint` — clean.
- New `test/logic/93.4-view-mutation.sqllogic` cases (all green):
  - **(a)** the repro — correlated view-col ref inside `exists` over a base table
    that *also* has a same-named base column; asserts the write lands on the
    renamed base column (`lbl`), i.e. the silent no-op is gone. *This is the case
    that fails without the fix* (predicate would re-bind to base `note`, match
    nothing).
  - **(b)** correlated view-col ref inside `in (select … where g = category)`.
  - **(c)** subquery-local same-named column (`in (select note from src)` where
    `src.note` exists, view renames `lbl`→`note`) — *not* substituted (a naive
    substitute-every-name fix would break this / not resolve).
  - **(d)** subquery referencing no view column — unchanged.
  - **(e1)** multi-source join view: view-col ref nested in `exists` in the user
    WHERE → routed to the alias-qualified base term, correlating to the join body.
  - **(e2)** multi-source: view-col ref nested in a SET-value scalar subquery →
    owning-side base term, qualifier stripped through the subquery.
  - **(f)** conservative reject: a `select *` subquery source **and** a TVF
    (`table_info(...)`) subquery source → structured `unsupported-subquery-correlation`
    ("cannot write through view").

## Reviewer focus / honest residual gaps

The reviewer should treat the tests as a **floor**. Known residuals (each is a
narrow edge, none reintroduces the silent-corruption class the ticket targets):

1. **Single-source base terms are unqualified.** `columnMap` maps a view column to
   an *unqualified* base ref (e.g. `note`→`lbl`). The descent decides *whether* to
   substitute scope-aware, but the resulting unqualified `lbl` then resolves by
   ordinary SQL scoping inside the subquery. If the subquery's FROM contains a
   *different* source that *also* has an `lbl` column, the substituted ref binds
   there (innermost) instead of correlating to the outer base row. The repro and
   tests avoid this (subquery sources lack the base column name). Multi-source
   doesn't have this issue (its base terms are alias-qualified). A fix would
   qualify the single-source base term with the base table name; deferred as it
   touches the top-level remapper path broadly and was out of scope here. **Worth
   a reviewer probe / possible follow-up ticket** if you can construct a failing
   case.

2. **`stripSideQualifier` descent is qualifier-based (not scope-aware).** It strips
   the owning alias / rejects the other alias uniformly at every nesting depth.
   Correct for the realistic cases (an owning-side ref in a SET-value subquery
   correlates to the target row); a *pathological* subquery that rebinds the owning
   alias to its own local source could over-strip. No test exercises this; flagged.

3. **CTE-bearing predicate subqueries** are handled only conservatively: a CTE name
   in a subquery's FROM is unresolvable (`getTable`/`getView`/`getMV` miss) → the
   scope taints → a view-col ref there rejects; a CTE-using subquery with *no*
   view-col ref passes through. CTE bodies are not descended into (standard CTEs
   can't correlate to the enclosing query, so no view-column substitution is owed),
   but this isn't separately tested.

4. **`windowFunction` operands are still not descended** (pre-existing; window
   functions inside a DML predicate referencing a view column are exotic). Out of
   scope; unchanged from before.

5. **Property test not extended.** `test/property.spec.ts` § View Round-Trip Laws
   exercises view-*body* shapes, not subquery-in-predicate; the ticket's "consider"
   was conditional on a subquery-bearing view body being in scope there, which this
   change does not add. Left as-is.

6. **Verify the byte-identical claim** for `transformExpr` with `descend` omitted
   and the `cloneExpr` deep-clone change against the decomposition / lens callers —
   the full suite covers them, but a reviewer eyeballing `decomposition.ts`'s
   `anchorPredicate` (which independently rejects subqueries via `refs.hasSubquery`)
   confirming it's unaffected would be worthwhile.
