description: Review the multi-level (CTE-over-CTE / inline-subquery-over-CTE) DML-target flattener that AST-collapses a linear single-source CTE chain to its terminal base table so it writes through, instead of rejecting `no-base-lineage`.
prereq:
files:
  - packages/quereus/src/planner/mutation/cte-flatten.ts            # NEW — the recursive single-source CTE-body flattener (the whole feature)
  - packages/quereus/src/planner/building/dml-target.ts             # resolveCteTarget / resolveSubqueryTarget call flattenCteBody to produce selectAst; new ctesBefore helper
  - packages/quereus/test/logic/93.4-view-mutation.sqllogic         # the two v1-boundary reject blocks replaced with positive + reject-parity coverage
  - docs/view-updateability.md                                      # § CTEs "Multi-level CTE body — transparent inlining" + inline-subquery dual
difficulty: hard
----

# Review — CTE-name / inline-subquery DML target: transparent multi-level body

## What landed

A new pure-AST flattener (`planner/mutation/cte-flatten.ts`, `flattenCteBody`) collapses a
**linear single-source projection-and-filter chain** of sibling-CTE reads down to a flat
`select … from <terminal base table> …`, then feeds that as the ephemeral view-like's
`selectAst`. Every existing downstream consumer (`analyzeView`, `classifyViewBody`,
`buildCteSelfCapture`, the INSERT/UPDATE/DELETE rewriters, RETURNING) runs **unchanged** on a
genuine single base-table body. No planner / propagate / rewriter code changed — only the two
target resolvers in `dml-target.ts` now call `flattenCteBody`.

Design (as specified by the implement ticket): the flattener does **pure syntactic AST
composition** — projection substitution (`transformExpr` + `mapQueryExprUniform`) and filter
conjunction (`combineAnd`). All lineage / inverse reasoning stays in the existing planner,
which re-plans the flat body — so a `v + 1 as vp` inlined through two levels still inverts
`set vp = 9` to `v = 8`.

Per level (`flattenSelect` → `flattenInner` → `composeBody`):
- **Terminal** (FROM is a base table / view / MV, schema-qualified, or `=== targetName`):
  return the body's **original identity** unchanged — the common single-level path is provably
  untouched.
- **Inlinable sibling CTE**: recurse to flatten the inner against its **prior siblings only**
  (`ctesBefore` — definition-order visibility), then substitute the consumer's references with
  the inner's defining expressions, conjoin the two `where`s, re-point FROM at the terminal
  base table, and merge `defaults` (consumer-wins).
- **Non-updateable intermediate** (`assertInlinableInner`): reject with that intermediate's
  body-shape reason (`unsupported-aggregate` / `-distinct` / `-limit` / `-set-op` /
  `-join` / `no-base-lineage`) — the composition only carries projection+filter, so silently
  inlining would DROP the disqualifying clause. A non-updateable **consumer** (the target body
  itself) is carried through and rejected by the final `analyzeView` instead.

Substitution has a fast path: a `select *` inner with no rename ⇒ identity-strip (drop the
`sourceName.` qualifier, no schema touch, no map). The only `ctx.schemaManager` touch is a
column-rename over a `select *` inner (to pair renamed names with base columns positionally).

A visited-set + `MAX_FLATTEN_DEPTH` (64) guard converts a pathological AST into a structured
diagnostic rather than a stack overflow.

## Validation done

- `yarn workspace @quereus/quereus test` → **6216 passing, 9 pending** (full suite green).
- `yarn workspace @quereus/quereus lint` → clean (eslint + `tsc -p tsconfig.test.json`).
- `yarn typecheck` (src) → clean.

## Test coverage added (`93.4-view-mutation.sqllogic`)

Replaced the two v1-boundary reject blocks (CTE-over-CTE ~old L3182-3187, inline-subquery
~old L3576-3583) with positive + reject-parity coverage:

**CTE-name target (CTE-over-CTE):**
- 2-level positive UPDATE write-through (+ unaffected-row check)
- 3-level positive (`ml3 ← a ← b ← t`)
- INSERT through a 2-level chain
- DELETE through a 2-level chain
- RETURNING through a 2-level chain
- filter conjunction (intermediate's `where color='red'` survives)
- projection narrowing → `unknown-view-column` reject
- computed/inverse across levels (`v + 1 as vp`, `set vp=9 ⇒ v=8`)
- column rename (`a(p,q)` inner + renamed consumer)
- combined shadow + inline (`a` inlines, the target's own `base2` self-name does not)
- reject-parity for aggregate / distinct / set-op / join intermediates ("is not updateable in phase 1")

**Inline-subquery target (inline-over-CTE):**
- positive UPDATE + DELETE write-through
- reject-parity for an aggregate intermediate

The pre-existing shadow-case (`cte_base` / `base` / `hw*`), single-level CTE, recursive-CTE,
and self-read (Halloween) tests all stayed green.

## Known gaps / things to scrutinize (treat tests as a floor)

1. **Definition-order visibility is unit-evident, not end-to-end tested.** `ctesBefore`
   correctly restricts each inner to its prior siblings, and the *combined shadow+inline* test
   exercises target-name shadow-out + prior-sibling inlining. I deliberately did **not** add a
   collision-based forward-reference test (`with x as (select * from foo), foo as (…) update x`)
   because the CTE-name-target body is re-planned with **all** siblings in `cteNodes` (a
   pre-existing v1 simplification in `contextForCteTarget`, independent of the flattener), so a
   name that is both a later CTE and a real table resolves to the CTE on the re-plan and
   rejects (CTEReference → `no-base-lineage`) regardless of the flattener. The implement ticket
   asserted such a case "writes through to the real table" — that is **not** achievable in this
   ticket's scope without also changing the re-plan context. **Reviewer: confirm this reasoning
   and decide whether a forward-reference reject test (or a backlog ticket to make the re-plan
   respect per-CTE order) is warranted.**

2. **Rename-over-`select *` sub-case is implemented but untested.** `resolveInnerColumns` does
   the one schema-lookup path (`with a(p,q) as (select * from base), t as (select * from a)`),
   but only rename-over-**explicit** is covered by a sqllogic test (`mlren`). The schema-lookup
   branch and its error paths (unresolvable / arity-mismatch) have no dedicated test.

3. **3-level only tested for UPDATE**; INSERT/DELETE/RETURNING multi-level tested at 2 levels.

4. **Nested `withClause` inside a CTE body** is treated as terminal (top level) /
   non-inlinable-reject (as an intermediate) — a documented low-risk corner with no test.

5. **`mapQueryExprUniform` nested substitution** uses `nestedSubst` (only `sourceName`-qualified
   refs fire inside subquery operands — correct SQL scoping), while top-level uses bare+qualified.
   For the identity-strip path both are the same (qualifier-strip only), so the common path is
   zero-risk; the explicit-map path's over-substitution risk is bounded to an exotic name
   collision between an inner output name and a nested-subquery-local column. Worth a skeptical read.

6. **Coupling:** `cte-flatten.ts` imports `combineAnd` from `single-source.ts` (per the implement
   ticket's "reuse" directive). No import cycle (`single-source` imports neither `cte-flatten`
   nor `dml-target`), but the reviewer may prefer a local helper to keep the flattener
   dependency-light.

7. **The Phase-2 plan-node-threaded lineage generalization** (`analysis/update-lineage.ts`
   header, the "inline-and-propagate generality" comment in `single-source.ts` `analyzeView`)
   remains intentionally unwired — this ticket used AST flattening, a separate mechanism. Those
   comments still describe a distinct deferred capability and were left as-is; reviewer may want
   to cross-link them to the flattener.

## Usage

```sql
-- writes through to ml, byte-identical to collapsing the chain into one CTE body
with a as (select id, color from ml), t as (select * from a) update t set color='z' where id=1;
-- inline-subquery dual
with t as (select id, color from base) update (select id, color from t) as v set color='z' where v.id=1;
-- a non-updateable intermediate rejects with that shape's reason
with a as (select g, sum(v) as s from agg group by g), t as (select * from a) update t set s=0 where g=1;
-- error: is not updateable in phase 1
```
