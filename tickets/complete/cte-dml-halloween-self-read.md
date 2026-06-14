description: CTE-name DML target self-read (Halloween) — split planning context (target-excluded body + target-included eager capture) so `with t as (…) update t set … where id in (select id from t)` produces a Halloween-safe positive write instead of the prior clean reject. Reviewed and completed.
files:
  - packages/quereus/src/planner/mutation/scope-transform.ts        # cteNodes-source resolution + alias-shadow threading
  - packages/quereus/src/planner/mutation/single-source.ts          # buildCteSelfCapture, makeViewScope alias-shadow, descendCtx threading, MutableViewLike.cteTarget
  - packages/quereus/src/planner/building/dml-target.ts             # cteTarget flag, needsSelfCapture AST scan
  - packages/quereus/src/planner/building/view-mutation-builder.ts  # withCteCapture, self-read gating + wiring (descendCtx, identityCapture)
  - packages/quereus/src/planner/mutation/propagate.ts              # forward descendCtx to rewriteViewUpdate/Delete
  - packages/quereus/test/logic/93.4-view-mutation.sqllogic         # positive-write assertions + multi-reference coverage (~L3196+)
  - docs/view-updateability.md                                      # § Common Table Expressions self-reference rewrite
difficulty: medium
----

# Complete: CTE-name DML target self-read (Halloween) — split context + eager capture

## Summary

A *user-clause* self-read of a CTE-name DML target
(`with t as (…) update t set … where id in (select id from t)`) now produces a
Halloween-safe **positive write** rather than the prior clean reject. The fix threads
two planning contexts through the single-source spine:

- **`ctxBody`** (target-excluded) plans the body and builds the eager capture, so the
  body's own `from base` reaches the **real** base table (the load-bearing shadow case).
- **`ctxSelfRead`** = `ctxBody` with the target name re-added to `cteNodes`, resolving to
  a context-backed key relation over an eager, unfiltered capture of the whole body. It
  drives the view-column descend and the lowered base op's re-plan, so `from t` binds to a
  frozen pre-mutation snapshot.

The capture rides `ViewMutationNode.identityCapture` (materialized once before any base op
runs — no runtime changes). Two scope-transform enablers make it sound: `cteNodes`-backed
FROM sources resolve their columns (clean shadowing, not taint), and an alias-shadow set
threaded parallel to the column-name shadow set keeps a view-qualified self-read (`t.id`)
local. Gated to an ephemeral CTE-name target + single-source UPDATE/DELETE + an AST scan
(`needsSelfCapture`); absent a self-read the plan is byte-identical to before.

## Review findings

Validation re-run from scratch on the implement commit (`6eb33844`): `yarn build` ✅,
`yarn workspace @quereus/quereus lint` ✅ (exit 0), `yarn workspace @quereus/quereus test`
✅ **6216 passing / 0 failing / 9 pending** — all as the handoff claimed.

**Read the full implement diff first** (all six source/test/doc files), then probed the
gaps the handoff flagged as a floor. Aspects scrutinized:

- **Shared-ref-instance risk (the chief untested interaction).** `withCteCapture` mints the
  context-backed self-read ref **once**; the same `InternalRecursiveCTERefNode` instance
  serves both the AST descend and the base-op re-plan, and `buildFrom` embeds it directly
  (or wraps a fresh `AliasNode` over the same instance). So a statement with `from t` in
  **two positions** (WHERE + RETURNING, twice in one WHERE, WHERE + SET value) drives two
  plan-tree positions off one node — a case **no existing test exercised**. Probed all three
  empirically: each produces the correct frozen-snapshot result (WHERE+RETURNING → both rows
  written + pre-mutation count 2; twice-in-WHERE → correct set union; WHERE+SET → captured
  value applied). This is exactly what a context-backed CTE ref is designed for (read by
  descriptor identity, not node identity), so the sharing is **correct, not a bug**.
  **Minor fix applied:** added two sqllogic assertions (`hwmr`, `hwmr2`) locking in the
  multi-reference behavior, since the single-position tests didn't cover it.
- **`as AST.SelectStmt` cast in `buildCteSelfCapture`.** Safe: `analyzeView` runs on the line
  above and rejects any non-`select` body (and, via `classifyViewBody`, set-op / aggregate /
  join / VALUES / recursive bodies) before the cast is reached. A compound/union select is
  structurally a `SelectStmt` anyway.
- **Reject parity for unsupported bodies WITH a self-read.** Probed aggregate-body and
  distinct-body self-reads: both reject cleanly via `buildCteSelfCapture`'s `analyzeView`
  with the **same** structured diagnostics the no-self-read path raises (`Aggregate … not
  updateable in phase 1`, `DISTINCT body has no 1:1 base-row lineage`). No crash; the reject
  just happens earlier in the pipeline.
- **Body-own-WHERE vs user-WHERE.** Confirmed "unfiltered" in the handoff means *no user
  WHERE* — the capture still includes the body's own filter (`buildSelectStmt(ctx, sel)`
  carries `sel.where`). Probed `with t as (select … where color='red')`: the self-read sees
  only the filtered rows and the base op writes only them. Correct.
- **Alias-shadow blast radius.** The new `aliasShadowed` branch in `makeViewScope`'s
  `makeSubstitute` now fires for *every* view/CTE mutation descend (not only self-reads). It
  only changes behavior when a subquery aliases a FROM source with the **same name as the
  view** — previously mis-rewritten to the outer base term, now correctly left local
  (innermost-scope SQL rules). The same-base-table self-reference corner (`from base` where
  base ≠ view name) is unaffected. Full suite passes, so no existing query regressed; the
  change is a strict correctness improvement. The other `ScopeContext` implementers
  (`makeBaseQualifyScope` / `makeSideQualifyScope` / lens-enforcement) ignore the third
  param harmlessly.
- **`needsSelfCapture` window-frame-bound under-detection (handoff-flagged).** Confirmed
  **safe**: a missed self-read builds no capture, so `from t` is unresolvable under the
  target-excluded ctx → clean table-not-found reject, never a silent wrong write. (Subqueries
  in window frame bounds are exotic/unsupported anyway.) Acceptable boundary.
- **Docs.** Read every touched doc section. `docs/view-updateability.md` § Common Table
  Expressions self-reference and § Inline subquery DML target accurately describe the split
  context + eager capture; the v1-boundaries list is updated (INSERT-source and join-bodied
  self-reads are the remaining documented deferrals). The cross-reference anchor
  (`#common-table-expressions-and-the-cte-name-dml-target`) resolves to a real heading.

**Disposition:** one **minor** fix applied in-pass (multi-reference sqllogic coverage).
No **major** findings — no new tickets filed. The out-of-scope INSERT-source self-read
follow-up the handoff floated was judged **not worth a ticket**: it cleanly table-not-founds
(not silently wrong), and the CTE-name/inline-subquery paths already cover the common
"write through a derived relation" need. The "isolated scope-transform unit spec" gap was
also judged not worth filing — the two enablers are covered by *discriminating* integration
tests (the `sum(t.id)`=6-vs-3 alias-shadow probe; the sibling-CTE + self-read no-taint
probes) that are stronger than a synthetic in-isolation `ScopeContext` test.

## Out of scope (verified unchanged)

Recursive CTE target (rejected up front), set-op / aggregate / distinct / limit bodies
(existing body-shape rejects), inline-subquery self-read (already a positive write via the
real base table), INSERT-source self-read (clean table-not-found), join-bodied multi-source
CTE self-read (clean `cannot be proven correlated` reject).
