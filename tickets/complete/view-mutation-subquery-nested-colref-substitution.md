description: Scope-aware descent that rewrites a view-column reference nested inside a `subquery` / `exists` / `in`-subquery operand of a view-mediated DML predicate / SET value to its base-term lineage (fixing a silent wrong write), with a conservative `unsupported-subquery-correlation` reject for the unanalyzable tail. Covers the single-source spine and the multi-source join walk. Reviewed and completed; one major residual (single-source unqualified base term) confirmed reproducing silent corruption and filed as a follow-up fix.
files: packages/quereus/src/planner/mutation/single-source.ts, packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/mutation/mutation-diagnostic.ts, packages/quereus/test/logic/93.4-view-mutation.sqllogic, docs/view-updateability.md
----

## What landed (summary)

`transformExpr` gained an optional `descend` hook and explicit `subquery` /
`exists` / `in.subquery` arms, so a view-column reference nested inside a subquery
operand of a user predicate / SET value is rewritten to its base-term lineage
instead of being passed through to silently re-bind to a same-named base column in
the lowered statement (the original silent-wrong-write).

- **Scope-aware descent** (`transformQueryExpr` + `makeViewSubstitute` and the
  `collectFromColumnNames` / `fromSourceColumnNames` / `tableSourceColumnNames` /
  `projectionOutputNames` resolver chain). Threads `shadowed` (names enclosing
  subquery scopes introduce) and `tainted` (set once a scope's locals are not
  statically resolvable). Substitutes only a reference qualified by the view name,
  or unqualified + a known view column + not shadowed (correlated to the outer view
  row). A tainted scope rejects an unqualified view-column-named reference via the
  new `unsupported-subquery-correlation` diagnostic rather than mis-binding.
- **`cloneExpr` now deep-clones subqueries** via `cloneQueryExpr` /
  `mapQueryExprUniform` (passed as `descend`). Strictly safer; removes shared inner
  AST nodes in the multi-source identifying-predicate clones.
- **Wiring.** single-source `rewriteViewUpdate` / `rewriteViewDelete` thread a
  `makeViewColumnDescend` descent into the `transformExpr` calls; multi-source
  `substituteViewColumns` (and `stripSideQualifier`, via the qualifier-uniform
  `mapQueryExprUniform`) thread the same, with `ctx` flowing from
  `propagateMultiSource` down to `buildIdentifyingPredicate`.
- **INSERT** intentionally not descended (no outer view row to correlate to).
- Compound/union legs walked as siblings (outer scope); nested FROM subquery
  sources inherit this select's FROM. CTE names taint (conservative reject);
  `windowFunction` operands still not descended (pre-existing, exotic).

Tests: new 93.4-view-mutation.sqllogic cases (a)–(f). Docs:
`docs/view-updateability.md` § Selection gained a "View columns nested inside a
predicate / assigned-value subquery" note and updated the `single-source.ts` /
`multi-source.ts` file-map lines.

## Review findings

Reviewed the implement diff (`281622e3`) first with fresh eyes, then read the full
`single-source.ts` descent in context, the AST shapes it walks
(`SelectStmt` / `FromClause` / `InExpr` / `SubqueryExpr` / `ExistsExpr` /
`ResultColumn` in `parser/ast.ts`), the multi-source threading, and the shipped
docs. Ran typecheck (clean), lint (clean), and the full quereus suite
(**4163 passing, 9 pending, 0 failing**).

### Major — filed as follow-up (NOT fixed in this pass)

- **Single-source substitutes to an *unqualified* base term, which can re-bind to a
  subquery-local source of the same base name — a confirmed silent wrong write.**
  This is the implementer's residual gap #1, and a review probe confirmed it
  reproduces the exact silent-corruption class the parent ticket targeted (a row
  that must NOT match was silently updated). The scope-aware descent decides
  *whether* to substitute correctly; the hole is that the *replacement* it emits
  (e.g. `note` → bare `lbl`) resolves by ordinary innermost SQL scoping inside the
  subquery and binds to a local `lbl` source instead of correlating to the outer
  base row. A sibling shape (`where lbl = note`) instead raises a runtime
  `No row context found for column lbl`. Multi-source is unaffected (alias-qualified
  base terms). Filed as
  **`tickets/fix/view-mutation-single-source-subquery-base-term-local-rebind.md`**
  with the confirmed repro and fix direction (qualify the single-source base term
  with the base table name, mirroring multi-source; or extend the taint to the base
  name as a conservative fallback). Not fixed inline because the qualified-term fix
  touches the top-level remapper path broadly and must be verified not to regress
  the non-subquery (single-source) path — too large for a review-pass inline fix.

### Verified sound (checked, no change needed)

- **`transformExpr` with `descend` omitted is behaviourally unchanged.** Every
  pre-existing caller (`decomposition.ts` `anchorPredicate`, `lens-enforcement.ts`,
  `normalizeBaseRefs`, the top-level remappers) passes no `descend`; the new arms
  (`subquery` / `exists` / `in.subquery`) fall back to the original operand when
  `descend` is undefined. The old `in` arm already preserved its `subquery` field
  via the `...expr` spread, so the only net change for the no-`descend` path is that
  `cloneExpr` now *deep-clones* the inner query instead of sharing the node —
  strictly safer. The full suite (which exercises all those callers) stays green.
  (The handoff's phrasing that the `in` arm "previously dropped the subquery operand
  entirely" is inaccurate — it was preserved-but-shared, not dropped — but the
  shipped code and docs are correct; no action.)
- **AST coverage of the rebuild walkers is complete for the descended cases.**
  `rebuildSelect` threads every expression-bearing `SelectStmt` field (columns /
  where / groupBy / having / orderBy / limit / offset / join ON / compound / union)
  and preserves `withClause` / `distinct` / `all` structurally via spread;
  `rebuildFrom` covers all four `FromClause` variants (table / join /
  functionSource / subquerySource). `compound.select` (a `QueryExpr`) and `union`
  (a `SelectStmt`) are both routed through `onLeg` as siblings — correct, a UNION
  leg correlates to the same outer scope, not this select's FROM.
- **Scope threading is conservative-correct.** A FROM-clause subquery source
  inherits `innerShadow`/`scopeTainted` (a superset of names), which can only
  *suppress* substitution — never spuriously fire it. Compound legs keep the
  incoming (outer) shadow/taint. VALUES (no FROM) keeps the incoming scope.
  Unresolvable sources (`select *`, TVF, CTE name, embedded DML, union/compound
  subquery source) all taint → reject, exercised by case (f).
- **Multi-source base terms are alias-qualified** (`p.label`), so the residual #1
  local-rebind hazard does not apply there; the alias correlates to the join body
  that becomes the identifying subquery's FROM (case e1/e2 confirm).

### Minor residuals — noted, not actioned (each a narrow/exotic edge, documented)

- **`stripSideQualifier`'s descent is qualifier-uniform, not scope-aware**
  (implementer residual #2). A *pathological* multi-source SET-value subquery that
  rebinds the owning alias to its own local source could over-strip / over-reject.
  No realistic query hits this; the realistic owning-side correlation (case e2) is
  correct. Left as-is — filing a ticket for a purely pathological shape isn't
  warranted; re-evaluate if a real query surfaces it.
- **CTE-bearing predicate subqueries** (residual #3) are handled conservatively: a
  CTE name in a subquery FROM is unresolvable → taint → a nested view-col ref
  rejects; a CTE-using subquery with no view-col ref passes through. CTE bodies are
  not descended (standard CTEs can't correlate to the enclosing query). Safe
  (reject over corrupt); not separately tested.
- **`windowFunction` operands not descended** (residual #4, pre-existing). A view
  column inside a window function in a DML predicate is exotic and was never
  substituted (top-level or nested). Out of scope; unchanged.
- **Property test not extended** (residual #5). § View Round-Trip Laws exercises
  view-*body* shapes, not subquery-in-predicate; adding a subquery-bearing view
  body was out of scope and the change does not introduce one. Left as-is.

### Tests

The implementer's cases (a)–(f) are a sound floor: repro (a), in-subquery
correlation (b), subquery-local same-name negative control (c), no-view-col
passthrough (d), multi-source nested-in-WHERE (e1) and nested-in-SET-value (e2),
and conservative reject for `select *` + TVF sources (f). All green. The gap they
miss is residual #1's local-rebind shape — now captured (with the confirmed
failing repro) in the follow-up fix ticket, where its regression test belongs.
