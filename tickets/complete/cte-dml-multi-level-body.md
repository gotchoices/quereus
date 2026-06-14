----
description: Multi-level (CTE-over-CTE / inline-subquery-over-CTE) DML-target flattener that AST-collapses a linear single-source CTE chain to its terminal base table so it writes through, instead of rejecting `no-base-lineage`. Reviewed and completed.
files:
  - packages/quereus/src/planner/mutation/cte-flatten.ts
  - packages/quereus/src/planner/building/dml-target.ts
  - packages/quereus/test/logic/93.4-view-mutation.sqllogic
  - docs/view-updateability.md
----

# Complete — multi-level CTE / inline-subquery DML target: transparent body flattening

## What shipped

A pure-AST flattener (`planner/mutation/cte-flatten.ts`, `flattenCteBody`) collapses a
linear single-source projection-and-filter chain of sibling-CTE reads down to a flat
`select … from <terminal base table> …`, fed as the ephemeral view-like's `selectAst`. Every
downstream consumer (`analyzeView`, `classifyViewBody`, the INSERT/UPDATE/DELETE rewriters,
RETURNING, self-read capture) runs unchanged on a genuine single base-table body. Only the two
target resolvers in `dml-target.ts` call `flattenCteBody`; no planner / propagate / rewriter
code changed.

The flattener does pure syntactic composition — projection substitution + filter conjunction —
and leaves all lineage / inverse reasoning to the planner that re-plans the flat body. A
non-updateable intermediate rejects with that intermediate's body-shape reason; a non-updateable
consumer is carried through and rejected by the final `analyzeView`. The target's own name is
shadowed out so the `with base as (… from base) …` case stays terminal; only prior siblings
inline (definition-order visibility). A visited-set + depth cap guards against pathological ASTs.

See `docs/view-updateability.md` § CTEs ("Multi-level CTE body — transparent inlining") and the
inline-subquery dual.

## Review findings

Adversarial pass over the implement-stage diff (commit `8aa256de`), read first with fresh eyes.
Validation: `yarn workspace @quereus/quereus test` → **6216 passing, 9 pending** (full suite
green, including the added cases); `yarn lint` (eslint + `tsc -p tsconfig.test.json`) → clean;
`tsc --noEmit` (src) → clean.

**Scrutinized — clean:**
- **Substitution / composition correctness** (identity-strip vs explicit-map paths, filter
  conjunction via `combineAnd`, FROM re-point, `defaults` merge, column rename, computed/inverse
  across levels) — traced each path against the AST and the test results; the common single-level
  path returns original identity untouched, as designed.
- **Reject parity** — aggregate / distinct / limit / set-op / join intermediates each reject with
  the matching body-shape reason; verified by the parity tests for both target kinds.
- **Cycle / depth guard** — `visited` set + `MAX_FLATTEN_DEPTH` are belt-and-suspenders under
  prior-sibling-only visibility (a true cycle is impossible); fine.
- **Coupling** — `combineAnd` import from `single-source.ts` introduces no cycle; acceptable.
- **Docs** — read every touched file; `view-updateability.md` reflects the new reality. Added a
  forward-reference boundary bullet (see below).

**Found & fixed inline (minor):**
- **`inverse`-clause aliasing.** `composeColumns` (`inverse: rc.inverse`) and `cloneResultColumn`
  (spread) leaked the consumer's `with inverse` array/expressions by reference into the produced
  body, violating the "sever all sharing" invariant the entire `scope-transform` module upholds
  (its sibling `cloneResultColumns` always deep-clones inverse). Latent (the read-plan path does
  not currently mutate inverses in place) but inconsistent. **Fixed:** added `cloneInverse`,
  used in both spots.
- **Test gap — rename-over-`select *` schema-lookup branch** (handoff gap #2): the only
  `schemaManager.getTable` path in `resolveInnerColumns` had no test. **Added** a positive
  write-through case (`mlrens`, `with a(p,q) as (select * from base), t as (select * from a)`).
- **Boundary not pinned — forward reference** (handoff gap #1): empirically confirmed it rejects
  cleanly (`CTEReference … not updateable`), never silent-wrong / wrong-table. **Added** a
  boundary reject test + a `view-updateability.md` v1-boundary bullet, and filed
  `cte-dml-forward-reference-visibility` (backlog) to make the re-plan context respect per-CTE
  definition-order visibility (a `contextForCteTarget` limitation, orthogonal to the flattener).

**Found & deferred to backlog (major):**
- **Silent-correctness bug — nested-subquery alias shadowing** (handoff gap #5, confirmed by
  construction). When a subquery nested in the consumer body re-binds the inner CTE's source
  name as a *local* FROM alias, the blind `nestedSubst` (via `mapQueryExprUniform`) rewrites that
  alias's qualified column references to the outer inner-CTE's defining expression instead of
  leaving them local — a wrong result with no diagnostic. Reproduced: an EXISTS that should fire
  via `nother.note='red'` instead tested `nother.color`, so the UPDATE silently did not fire.
  Trigger is exotic (source name re-used as a nested alias + a renamed/computed column-name
  collision; the identity-strip fast path is immune). Proper fix is scope-aware substitution
  (reuse `scope-transform`'s alias-shadow machinery) — an architectural change with its own test
  surface, too large for this pass. Filed `cte-flatten-nested-alias-shadow-substitution`
  (backlog) with the reproduction.

**Accepted as-is (documented, low-value to extend now):**
- 3-level chains tested for UPDATE only; INSERT/DELETE/RETURNING multi-level at 2 levels (handoff
  gap #3) — coverage depth, not a correctness concern.
- Nested `withClause` inside a CTE body treated as terminal / non-inlinable-reject (handoff gap
  #4) — handled cleanly on both sides, low-risk corner.
- The Phase-2 plan-node-threaded lineage comments (handoff gap #7) describe a distinct deferred
  mechanism; left as-is.

## Follow-up tickets filed

- `tickets/backlog/cte-flatten-nested-alias-shadow-substitution.md` — silent-wrong on the
  nested-alias collision; scope-aware substitution fix.
- `tickets/backlog/cte-dml-forward-reference-visibility.md` — forward-reference-to-shadowed-table
  should write through; per-CTE definition-order visibility in the re-plan context.
