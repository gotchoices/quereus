description: Let a CTE-name (or inline-subquery) DML target whose body reads ANOTHER CTE (`with a as (…), t as (select * from a) update t …`) write through transparently by AST-flattening the multi-level single-source chain down to its terminal base table, instead of rejecting with `no-base-lineage`.
prereq:
files:
  - packages/quereus/src/planner/mutation/cte-flatten.ts            # NEW — the recursive single-source CTE-body flattener
  - packages/quereus/src/planner/building/dml-target.ts             # resolveCteTarget / resolveSubqueryTarget call the flattener to produce a flat selectAst
  - packages/quereus/src/planner/mutation/scope-transform.ts        # transformExpr / cloneExpr / cloneQueryExpr reused for the substitution
  - packages/quereus/src/planner/mutation/single-source.ts          # analyzeView — the gate that rejects (consumes the flattened body unchanged)
  - packages/quereus/src/planner/mutation/propagate.ts              # classifyViewBody — the plan walk that hits CTEReference → no-base-lineage
  - packages/quereus/src/parser/ast.ts                              # SelectStmt / ResultColumn / FromClause / SubquerySource shapes
  - packages/quereus/test/logic/93.4-view-mutation.sqllogic         # lines ~3182-3187 & ~3576-3583 — replace the v1-boundary reject assertions
  - docs/view-updateability.md                                      # § CTEs (lines ~691, ~714) — replace the multi-level v1 boundary
difficulty: hard
----

# CTE-name DML target: transparent multi-level (CTE-over-CTE) body

## Why it rejects today

`resolveCteTarget` (`building/dml-target.ts`) wraps the target CTE's body AST in an
ephemeral `MutableViewLike` whose `selectAst` is `cte.query` verbatim. When that body's
single FROM source is **another CTE** —

```sql
with a as (select id, color from ml), t as (select * from a) update t set color='z' where id=1
```

— `analyzeView` (`mutation/single-source.ts`) plans the body under the CTE-threaded
context; `buildFrom` resolves the FROM name `a` against `cteNodes` to a **`CTEReferenceNode`**
(siblings stay in scope — only the target's own name is shadowed out by
`contextForCteTarget`). `classifyViewBody` (`mutation/propagate.ts`) walks the planned body,
hits the `CTEReferenceNode` (not in `PASSTHROUGH_NODES`, not a `TableReferenceNode`), and
falls through `reasonForOperator`'s default → **`no-base-lineage`** ("is not updateable in
phase 1"). The same happens for the inline-subquery dual `with t as (…) update (select … from t) as v …`.

The substrate is **AST-driven**: `analyzeView` reads the base table from the plan
classification but derives the `columnMap`, `filterPredicate`, and projection list from
`view.selectAst` directly. Driving that off a body whose FROM is a CTE would silently drop
the inner CTE's own projection/filter (the existing comment at `single-source.ts` ~L482
names exactly this). The plan-node-threaded generalization that would compose lineage through
arbitrary nesting is the documented Phase-2 foundation and is intentionally NOT wired
(`analysis/update-lineage.ts` header, `docs/view-updateability.md` § Status).

## Approach — flatten the chain to one base-table body, reuse everything downstream

Produce a **flattened `SelectStmt`** over the terminal base table (`select … from ml where …`)
and feed it as the ephemeral view-like's `selectAst`. Then every downstream consumer —
`analyzeView`, `classifyViewBody`, `bodyDefaults`, `isJoinBody`, `buildCteSelfCapture`, the
INSERT/UPDATE/DELETE rewriters, RETURNING — runs **unchanged** on a genuine single-source
projection-and-filter body. This is exactly the acceptance bar: *byte-identical to
collapsing the chain into one CTE body*. All the hard lineage/inverse composition stays in
the existing planner (`deriveProjectUpdateLineage` composes inverses/passthrough/authored
when `analyzeView` re-plans the flat body); the flattener does **pure syntactic AST
composition** — projection substitution + filter conjunction.

### The flattener (`mutation/cte-flatten.ts`)

```
flattenCteBody(ctx, body: SelectStmt, visible: CommonTableExpr[], targetName?): SelectStmt
```

`visible` is the CTEs that resolve in `body`'s FROM, **in definition order**; the recursion
respects ordering (a CTE inlines only against CTEs defined *before* it — matching
`buildWithClause`/`existingCTEs` scoping). `targetName` (CTE-name target only) is the
self-name that must NOT be inlined (the load-bearing shadow case — see below).

Per level, on a `select` body whose `from` is a single `{type:'table'}` source `X`:

1. **Not a CTE source** (`X` not in `visible`, or schema-qualified, or `=== targetName`):
   terminal — return the body **unchanged** (it is already `select … from <baseOrViewOrMV>`;
   `analyzeView` handles base tables natively and still rejects view/MV terminals as
   `nested-view`). This is the no-op fast path that keeps every existing single-level test
   byte-identical.

2. **`X` is an inlinable sibling CTE**: recurse to get `innerFlat = flattenCteBody(inner.query,
   visiblePrefixOf(inner), undefined)`, then **compose**:
   - Build the inner substitution: `innerName = X.alias ?? X.table.name` (lowercased). From
     `innerFlat`'s projection + `inner.columns` rename list, map each inner OUTPUT name → its
     defining expression. `select *` inner ⇒ the map is **identity** (every column maps to
     itself), so substitution is just *strip the `innerName.` qualifier* — **no base-table
     column list / schema lookup needed**. Explicit inner projection ⇒ name → cloned
     projection expr. (A `columns` rename over a `select *` inner is the one case that needs
     the base-table column list to pair renamed names with positions — resolve it via
     `ctx.schemaManager` on `innerFlat`'s base table; this is the only schema touch.)
   - Substitute the consumer's projection + `where` with that map via `transformExpr(expr,
     subst, descend)` (reuse `scope-transform.ts`; `descend` recurses so a reference nested in
     a subquery operand of the CTE body is rewritten too).
   - Result projection: consumer `select *` ⇒ `innerFlat`'s projection verbatim; explicit ⇒
     the substituted consumer columns.
   - Result `from` = `innerFlat.from` (terminal base table + its alias). Result `where` =
     `combineAnd(substituted consumer.where, innerFlat.where)`. Merge `defaults`
     (consumer-wins on a column collision).

3. **Non-inlinable intermediate** — reject with the matching structured reason so the
   chain rejects with *that intermediate's diagnostic* (reason parity with `analyzeView`):
   - `distinct` → `unsupported-distinct`; `limit`/`offset` → `unsupported-limit`;
     `groupBy`/`having` → `unsupported-aggregate`; `compound`/`union` → `unsupported-set-op`;
     `from.length !== 1` or a join FROM → `unsupported-join`; FROM is a `subquerySource` or
     the body isn't a `select` → `no-base-lineage`.
   - **Aggregate-without-`group by`** (`select sum(v) from a`) needs no detection here: it has
     no `groupBy`, so it composes by ordinary substitution (`sum(v')`), and the FINAL
     `analyzeView` on the flattened body rejects it `unsupported-aggregate` — same reason.

`flattenCteBody` returns the **original object identity** when nothing was inlined, so the
common path is provably untouched.

### Wiring (`building/dml-target.ts`)

- `resolveCteTarget`: after locating `cte`, set `selectAst = flattenCteBody(ctx, cte.query,
  ctesBefore(cte), cte.name)` when `cte.query` is a SELECT whose single FROM source names a
  visible sibling CTE; else `cte.query` (today's value). `ctesBefore(cte)` = the `withClause.ctes`
  prefix up to (not including) `cte` — and `targetName = cte.name` enforces the shadow-out.
- `resolveSubqueryTarget`: flatten `source.subquery` against `stmt.withClause?.ctes ?? []`
  (an inline subquery sees ALL the statement's CTEs; no own-name to shadow → `targetName`
  undefined). `stmt.withClause` is already in scope here — no signature change.

No change to `update.ts` / `delete.ts` / `insert.ts` dispatch, `analyzeView`, `propagate`,
or the rewriters. The self-capture path (`needsSelfCapture` / `buildCteSelfCapture`) keeps
working: it keys entirely off `view.selectAst`, which is now the flattened body, and the
user-clause self-read scan is over the unchanged `stmt`.

## Edge cases & interactions

- **Load-bearing shadow case** `with base as (select id,color from base) update base …`: the
  target's own name is excluded from `visible` (`targetName`), so `from base` is the terminal
  REAL table — `flattenCteBody` is a no-op and the body is unchanged. MUST stay byte-identical
  (existing `cte_base` tests). Combine with a real intermediate too:
  `with a as (select id,color from base), base as (select * from a) update base …` — here
  `a` (defined before `base`) inlines, `base`'s self-name does not.
- **Definition-order visibility**: `with x as (select * from foo), foo as (…) … update x …` —
  `x`'s `from foo` is the real table `foo` (the `foo` CTE is defined *after* `x`, invisible to
  it). `visiblePrefixOf` must exclude later siblings; do NOT inline `foo` into `x`. Add a test.
- **Three+ level chains** (`ml ← a ← b ← t`): recursion composes them; filters conjoin in
  order, projections substitute through each level.
- **Projection narrowing**: `a as (select id,color from ml), t as (select id from a)` — `t`
  exposes only `id`; flatten yields `select id from ml`. An `update t set color=…` must reject
  `unknown-view-column` (color is not a `t` column), same as the collapsed single CTE.
- **Filter conjunction**: `a as (select * from ml where color='red'), t as (select * from a)
  update t set color='z'` updates only red rows — `a`'s `where` survives into the flat body.
- **Computed / inverse across levels**: `a as (select id, v+1 as vp from ml2), t as (select *
  from a) update t set vp=9` ⇒ `ml2.v=8`. The inverse is recovered by the planner from the
  flattened `select id, v+1 as vp from ml2`, NOT by the flattener (which just substitutes
  syntactically) — verifies the "delegate lineage to the planner" design.
- **Column rename** `with a(p,q) as (select id,color from ml), t as (select p as id, q as
  color from a)` — inner output names are the renamed `p,q`; substitution maps them to
  `id,color`. Cover the `rename-over-select-*` sub-case (the one schema-touch path) with a
  test, or reject it cleanly if you choose to defer it — document whichever.
- **Non-updateable intermediate** (aggregate / `distinct` / `limit` / `offset` / set-op /
  join / window): rejects with the matching reason (parity with the equivalent view body and
  with a single-level CTE of that shape). Test each at least at the aggregate + distinct +
  set-op + join level.
- **Inline-subquery dual**: `with t as (select id,color from isq_ml) update (select id,color
  from t) as v set color='z' where v.id=1` now writes through. `v.id`/bare `id` resolve against
  the flattened body's output columns (unchanged); sibling-CTE reads in the user clause are
  unaffected.
- **Terminal is a view/MV** (`with a as (select * from someView), t as (select * from a)`):
  flatten inlines to `select * from someView`; `analyzeView`'s existing `getView` /
  `isMaintainedTable` guards reject `nested-view` (unchanged — multi-level into a view/MV
  terminal stays out of scope).
- **Nested `withClause` inside a CTE body** (a body carrying its own `with`): scope it to that
  body — do not cross-inline the outer chain into it. Leave the body unchanged at that level
  (terminal) and let `analyzeView` proceed/reject. Document; low-risk corner.
- **Cycle / depth guard**: non-recursive CTEs cannot cycle under definition-order visibility,
  but carry a visited-set / depth cap defensively and raise a structured diagnostic if violated.
- **All three ops**: flattening at resolve time covers INSERT, UPDATE, DELETE uniformly
  (all call `resolveCteTarget`; UPDATE/DELETE also `resolveSubqueryTarget`). Test INSERT +
  DELETE + RETURNING through a multi-level chain, not just UPDATE.
- **Plan-cache / ephemerality**: unchanged — the flattened body is derived from the statement
  AST every run; the target records no schema dependency.

## Acceptance

- A multi-level chain of single-source projection-filter members writes through to the
  terminal base table, byte-identical base-op effect to collapsing the chain into one CTE body
  (and to the equivalent `create view`).
- A chain with a non-updateable intermediate rejects with that intermediate's body-shape reason.
- The CTE-over-CTE **and** inline-subquery-over-CTE v1-boundary reject assertions in
  `93.4-view-mutation.sqllogic` (~L3182-3187, ~L3576-3583) are replaced with the new positive +
  reject-parity coverage; the shadow-case and single-level CTE tests stay green.
- `docs/view-updateability.md` § CTEs (the "Multi-level CTE body" v1 boundary ~L691 and the
  inline-subquery "Inline body that reads a CTE" boundary ~L714) are rewritten to describe
  transparent inlining.

## TODO

### Phase 1 — flattener
- Add `packages/quereus/src/planner/mutation/cte-flatten.ts` with `flattenCteBody` per above:
  per-level shape gate + reason mapping, inner-substitution builder (`*` ⇒ identity-strip,
  explicit ⇒ name→expr, rename handling), `transformExpr`-based composition, filter
  conjunction (`combineAnd`), defaults merge, definition-order visibility, cycle/depth guard.
- Keep it pure-AST: reuse `scope-transform.ts` (`transformExpr`, `cloneExpr`, `cloneQueryExpr`)
  and `raiseMutationDiagnostic`; do not re-implement lineage/inverse reasoning.

### Phase 2 — wiring
- `resolveCteTarget`: compute `visible` prefix + `targetName`, call `flattenCteBody`, use the
  result as `selectAst` (fall back to `cte.query` when nothing inlines).
- `resolveSubqueryTarget`: flatten `source.subquery` against `stmt.withClause?.ctes ?? []`.

### Phase 3 — tests (`test/logic/93.4-view-mutation.sqllogic`)
- Replace the two v1-boundary reject blocks with: 2- and 3-level positive write-through
  (UPDATE/INSERT/DELETE/RETURNING), projection-narrowing, filter-conjunction,
  computed/inverse-across-levels, rename, definition-order shadowing, combined shadow+inline,
  inline-subquery-over-CTE positive, and reject-parity for aggregate/distinct/set-op/join
  intermediates ("is not updateable in phase 1").
- Run `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/cte-ml.log; tail -n 60 /tmp/cte-ml.log`
  and `yarn workspace @quereus/quereus lint` (single-quote globs on Windows). Confirm the
  existing `cte_base` / shadow-case / single-level CTE tests stay green.

### Phase 4 — docs
- Rewrite the `docs/view-updateability.md` § CTEs multi-level v1 boundary and the inline-subquery
  "Inline body that reads a CTE" boundary into a "Multi-level CTE body — transparent inlining"
  description (flatten the linear single-source chain; non-updateable intermediates reject with
  the intermediate's reason). Remove the now-false "reaches a CTE node … rejects structurally" lines.
