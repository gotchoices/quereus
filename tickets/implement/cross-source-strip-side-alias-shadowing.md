description: Thread a FROM-alias shadow set through the cross-source SET-value qualifier strip (`stripSideQualifier`) so an inner value-subquery's FROM alias that collides with a join-side alias/table-name is left subquery-local instead of being mis-routed through the `__vmupd_keys` capture (partner-alias collision) or stripped bare (owning-alias collision).
files:
  - packages/quereus/src/planner/mutation/multi-source.ts      # stripSideQualifier (~2509-2568), its docstring, substituteViewColumns docstring (~2401-2440)
  - packages/quereus/src/planner/mutation/scope-transform.ts   # add collectFromAliases + transformAliasScopedExpr/Query (reuse transformExpr / rebuildSelect / cloneDmlStmt)
  - packages/quereus/test/logic/93.4-view-mutation.sqllogic    # append uq-17..uq-21 (see Key tests)
  - docs/view-updateability.md                                 # § Inner Join, cross-source `set` (lines ~149); correct the "purely syntactic at any depth" claim
difficulty: medium
----

# Alias-aware shadow tracking in the cross-source SET-value strip

## Background

A multi-source (join-view) UPDATE lowers each SET value to base terms in two passes:

1. **`substituteViewColumns`** (scope-aware, injection-time) rewrites *view-column*
   references to their base-term lineage and **side-alias-qualifies** every injected
   leaf (`makeSideQualifyScope`). This pass already respects column-**name** shadowing
   via `transformScopedQuery` / `collectFromColumnNames` (a bare name shadowed by an
   inner subquery's FROM is left local — tested by uq-9, uq-11, uq-12, uq-15).
2. **`stripSideQualifier`** then walks the result and routes by the column's `.table`
   qualifier: a qualifier matching the **owning** side's alias/table strips to bare
   (the lowered single-table UPDATE targets that base directly); a qualifier matching a
   **partner** side routes the read through the up-front `__vmupd_keys` capture
   (`registerCrossSource` → `capturedValueSubquery`). A bare qualifier is left untouched.

Pass 2 applies its substitute **uniformly at every nesting depth** through the
scope-**unaware** `mapQueryExprUniform` descent. Its docstring and `docs/view-updateability.md`
(§ Inner Join, cross-source `set`, ~line 149) justify this as "purely syntactic — a
*qualified* leaf cannot re-bind to a value subquery's own FROM."

## Problem

That justification holds only for **injected lineage leaves** (side aliases a user
subquery would not intentionally reuse). It is **false for user-authored qualified
references** whose qualifier collides with a side alias (or a side's table name). SQL
innermost-scope rules bind such a reference to the inner subquery's FROM source, but
the strip — seeing only the qualifier string — mis-routes it:

```sql
create view v as
    select c.cid as cid, cval, p.pv as pv
    from child c join parent p on p.pid = c.pref;
-- `p` is ALSO the alias of an unrelated inner FROM source:
update v set cval = (select max(p.score) from points p where p.k = cid);
--                              ^^^^^^^ subquery-local points.score, NOT parent.score
```

- **Partner-alias collision** (above): `p.score` has qualifier `p ∈ otherQuals`, so the
  strip routes it through `__vmupd_keys` as a captured `parent` read — but `parent` has
  no `score`, so it errors / reads the wrong column. `points.score` should stay local.
- **Owning-alias collision**: with an inner `from things c` (owning side alias `c`), a
  user `c.v` matches `owningQuals` and **strips to bare `v`**, changing how `v` resolves
  at the inner scope (escaping its local source).
- **Table-name collision**: `owningQuals`/`otherQuals` carry each side's table **name**
  too, so an inner source aliased with a side's table name (`from aux parent` where a
  side is `parent p`) collides on `parent` as well.

This is the *converse* of uq-9: uq-9 covers a **bare** user name colliding with a
partner base column (handled by pass 1's column-name shadowing); this ticket covers an
**alias-qualified** user reference colliding with a side alias (unhandled by pass 2).

## Expected behavior

A qualifier bound by an inner FROM alias (per innermost-scope rules) is left untouched
at that depth **and below**; only a qualifier that genuinely denotes a join side — not
shadowed by any enclosing value-subquery FROM alias between the strip root and the leaf
— participates in the strip/route. Non-colliding aliases behave exactly as today
(uq-1, uq-10, uq-13 unchanged). FROM aliases are **always statically known** from the
FROM clause, so alias shadowing never taints and never rejects — even an unresolvable
source (`select *` / TVF / CTE) still shadows its own alias.

## Design

Add a parallel **alias-shadow-aware descent** to `scope-transform.ts` and have
`stripSideQualifier` use it in place of the scope-unaware `mapQueryExprUniform`.

### Why a parallel mechanism, not an extension of `transformScopedQuery`

The ticket offers either. We choose the **parallel mechanism** because the strip's
decision is **alias-only**: it consults neither the column-name shadow set nor the
`tainted` flag, and — critically — it must **preserve its current DML-subquery
clone-through** (`mapQueryExprUniform` → `cloneDmlStmt`, no substitution, no reject).
Routing the strip through `transformScopedQuery` would (a) change the shared
`ScopeContext.makeSubstitute` signature for all three callers (single-source base-term
qualify, lens-enforcement, side-qualify), (b) reroute an embedded DML subquery to
`rejectDmlSubquery()` — a behavior change on an exotic shape — and (c) couple the strip
to column-name/taint semantics it never reads. A small dedicated descent that **reuses**
`transformExpr` / `rebuildSelect` / `cloneDmlStmt` keeps it DRY without that coupling.
(Tradeoff: the alias-accumulation/compound-leg/values scope rules are duplicated from
`transformScopedQuery`; they are simple and the two are co-located in one module —
keep the structure visibly parallel so a future reader sees the correspondence.)

### New in `scope-transform.ts`

```ts
/** Lowercased FROM aliases a subquery's FROM sources bind (never null — an alias is
 *  always statically known from the FROM clause, so it needs no taint signal). */
export function collectFromAliases(from: readonly AST.FromClause[] | undefined): Set<string>
// table          -> (alias ?? table.name)
// subquerySource -> alias            (SubquerySource.alias is required)
// functionSource -> (alias ?? name.name)
// join           -> union(left, right)

/** Alias-shadow-aware structural substitution over an expression, entered at the
 *  outermost scope (no inner FROM aliases yet). `substitute` receives the column and
 *  the set of FROM aliases shadowing at the current depth. Mirrors transformScopedQuery's
 *  scope rules but threads ONLY an alias set, and clones DML subqueries through (no
 *  substitution, no reject) — matching the strip's current mapQueryExprUniform behavior. */
export function transformAliasScopedExpr(
    expr: AST.Expression,
    substitute: (col: AST.ColumnExpr, aliasShadow: ReadonlySet<string>) => AST.Expression | undefined,
): AST.Expression
```

`transformAliasScopedQuery(query, substitute, aliasShadow)` (module-private) threads the
alias set exactly as `transformScopedQuery` threads `shadowed`:

- **select**: `inner = aliasShadow ∪ collectFromAliases(sel.from)`. This select's own
  clause expressions and any subquery nested in them see `inner`; a **compound / union
  leg** correlates to the same outer scope, so it keeps the incoming `aliasShadow`
  (mirror `onLeg`). Rebuild via the existing `rebuildSelect(sel, onExpr, onNested, onLeg)`.
- **values**: no FROM — keep the incoming `aliasShadow`.
- **non-select, non-values (DML … RETURNING subquery)**: structural clone via
  `cloneDmlStmt` (no substitution, no reject) — preserves current behavior.

### `stripSideQualifier` change

Build the substitute to short-circuit on a shadowed qualifier, then descend
alias-scoped instead of uniform:

```ts
const substitute = (col: AST.ColumnExpr, aliasShadow: ReadonlySet<string>): AST.Expression | undefined => {
    if (!col.table) return undefined;
    const t = col.table.toLowerCase();
    if (aliasShadow.has(t)) return undefined;            // bound by an inner FROM alias — local
    if (owningQuals.has(t)) return { type: 'column', name: col.name };
    if (otherQuals.has(t)) return routePartnerRead(col);
    return undefined;
};
return transformAliasScopedExpr(expr, substitute);
```

No new `ctx`/`PlanningContext` parameter is needed: `collectFromAliases` is purely
syntactic. At the top level `aliasShadow` is empty, so behavior is byte-identical for
every non-colliding statement. `routePartnerRead` (and thus the `registerCrossSource`
dedup + `gateCrossSourceCardinality` cardinality gate) still fires for genuine,
non-shadowed partner reads at any depth — uq-10 / uq-13 semantics are preserved.

## Edge cases & interactions

- **Partner-alias collision** (headline): inner `from points p`, ref `p.score` → local
  (NOT routed). Pick data where the mis-routed read would error or yield a different
  value than the correct local read, so a regression is loud.
- **Owning-alias collision**: inner `from things c` (owning alias `c`), ref `c.v` →
  local (NOT stripped to bare). `aliasShadow` is checked **before** `owningQuals`.
- **Table-name collision**: a side `parent p` makes `otherQuals`/`owningQuals` carry
  `parent`; an inner `from aux parent` must shadow `parent` (collectFromAliases records
  the inner alias). Verify the inner alias — not the table name — is what shadows.
- **Depth accumulation**: a collision introduced two levels down shadows that depth and
  below only; a shallower sibling reference to the *genuine* partner alias still routes.
- **Compound / union leg scoping**: an alias bound in one leg's FROM must NOT shadow a
  sibling leg (legs correlate to the enclosing scope). Mirror `transformScopedQuery`'s
  `onLeg` — keep incoming `aliasShadow`, not `inner`.
- **subquerySource body is a deeper scope**: `from (select … from points p) q` —
  `q` shadows at this level; inside the derived table, `p` shadows further down.
- **DML-subquery clone-through unchanged**: an embedded `(insert/update/delete …
  returning …)` value subquery is still structurally cloned (no substitution, no
  reject) — do not regress to `rejectDmlSubquery`.
- **values-source subquery** (`in (values …)`): no FROM; keep enclosing `aliasShadow`.
- **functionSource / TVF alias**: collect `alias ?? name.name`; a TVF whose columns are
  unresolvable still shadows its alias (no taint for aliases).
- **Non-colliding regression guard**: a genuine partner read nested in a subquery whose
  FROM uses a *different* alias must still route through the capture (capture + dedup +
  cardinality gate intact). uq-1 / uq-10 / uq-13 must stay green.
- **Top-level unchanged**: every existing statement with no inner FROM-alias collision
  produces an identical strip (empty `aliasShadow` at depth 0).

## Key tests (append to test/logic/93.4-view-mutation.sqllogic after uq-16)

In the spirit of TDD, write these first and confirm they fail on the current strip:

- **(uq-17) partner-alias collision**: view exposes `pv` from side `p`; an unrelated
  `points p (k, score)`; `update v set cval = (select max(p.score) from points p where
  p.k = cid) where cid = …`. Expect the local `points.score` result. Today this routes
  `p.score` to the `parent` capture → error / wrong; fixed → correct value.
- **(uq-18) owning-alias collision**: owning side alias `c`; inner `from things c`; a
  user `c.<col>` inside the value subquery must read `things`, not strip to bare and
  escape. Design data so the buggy strip changes the answer.
- **(uq-19) table-name collision**: side `parent p`; inner `from aux parent`; ref
  `parent.<col>` must stay local (the inner alias shadows the side's table name).
- **(uq-20) compound-leg negative scoping**: a `union`/compound value subquery where an
  alias bound in one leg's FROM must NOT shadow a genuine partner read in the sibling
  leg (the sibling read still routes). Keep it minimal; trim if it cannot be expressed
  cleanly, but document why.
- **(uq-21) non-colliding regression**: a genuine partner read nested in a subquery with
  a *non*-colliding inner alias still routes through the capture (assert the cross-source
  value is correct) — proves the fix narrows, not removes, routing.

## TODO

- Add `collectFromAliases(from)` to `scope-transform.ts` (purely syntactic; never null).
- Add `transformAliasScopedExpr` + private `transformAliasScopedQuery` to
  `scope-transform.ts`, reusing `transformExpr` / `rebuildSelect` / `cloneDmlStmt`;
  thread the alias set with the same select/values/compound-leg rules as
  `transformScopedQuery`, and clone DML subqueries through.
- Rewrite `stripSideQualifier`'s `substitute` to short-circuit on
  `aliasShadow.has(col.table)` and descend via `transformAliasScopedExpr` instead of
  `transformExpr(… mapQueryExprUniform …)`.
- Update the `stripSideQualifier` docstring and the inline "purely syntactic /
  scope-independent / scope-unaware descent" comment (~lines 2554-2559) and the
  `substituteViewColumns` docstring (~2401-2440) to record that a user-authored
  alias-qualified ref shadowed by an inner FROM is now left local.
- Correct `docs/view-updateability.md` § Inner Join, cross-source `set` (~line 149):
  the strip is qualifier-driven but **alias-scope-aware** — a *user-authored* qualified
  ref whose qualifier is shadowed by an inner value-subquery FROM binds locally (only
  *injected lineage leaves* are guaranteed collision-free).
- Add tests uq-17..uq-21; run `yarn workspace @quereus/quereus test` (and lint with the
  single-quoted glob) and confirm green, including the unchanged uq-1..uq-16.
