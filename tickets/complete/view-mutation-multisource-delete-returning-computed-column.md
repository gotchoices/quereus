description: Fix multi-source (two-table inner-join) DELETE ... RETURNING of a body-COMPUTED view column. The DELETE RETURNING projection is now built in base terms over the planned `joinNode` (mirroring the UPDATE RETURNING path) instead of referencing the optimizer-eliminated intermediate output attribute id of the planned body `root`. UPDATE/DELETE projection-lowering consolidated onto a shared helper.
files: packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/test/logic/93.4-view-mutation.sqllogic, packages/quereus/test/property.spec.ts, docs/view-updateability.md

## What shipped

**Root cause.** `buildViewOutputScope` registered each view-output column as a
`ColumnReferenceNode` pointing at the planned body `root`'s *output* attribute id. A
pass-through projection (`c.cid as cid`) forwards the leaf base attr id (survives
project-merge → resolves); a computed projection (`c.note || '!' as banner`) mints a
fresh intermediate attr id at `root`'s ProjectNode that project-merge collapses into an
inline expression — so the outer DELETE RETURNING reference to it dangled →
`QuereusError: No row context found for column banner`. UPDATE RETURNING was already
green because it recomputes from base terms.

**Fix.** Multi-source DELETE RETURNING now mirrors the UPDATE path: project the
view-spelled RETURNING columns **recomputed in base terms** over the already-planned
`analysis.joinNode`, filtered by the identifying predicate (user WHERE → base ∧ body
WHERE), captured `pre`. Nothing references a fragile intermediate attribute id.

**Consolidation.**
- `multi-source.ts`: extracted private `buildMultiSourceReturningProjection(ctx, view,
  analysis, filtered, returningCols)` — the projection-lowering both ops share, differing
  only in the `filtered` input relation. `buildMultiSourceUpdateReturning` now calls it.
- `multi-source.ts`: added/exported `buildMultiSourceDeleteReturning(ctx, view, stmt,
  analysis)` — builds the `pre` filter over `joinNode` via `buildIdentifyingPredicate`
  and delegates to the shared helper.
- `view-mutation-builder.ts`: the DELETE branch of `buildMultiSourceReturning` now calls
  `buildMultiSourceDeleteReturning`; the three now-dead helpers `buildDeleteReturning`,
  `buildViewOutputScope`, `buildViewReturningProjections` were deleted.
- `docs/view-updateability.md` § RETURNING: the `delete` (`pre`) bullet rewritten to
  describe the base-term recomputation.

The encapsulation guard is inherited: `buildReturningProjection` calls `guardTopLevelScope`
on each explicit RETURNING column, so a ref to a hidden base column (not a view output) is
rejected at plan time.

## Review findings

Adversarial pass over commit `4ee009d6`. Read all five touched files with fresh eyes
before the handoff summary.

**Checked — correctness / semantics:**
- *Root-cause logic.* The by-id-reference-dangles explanation holds: a computed view
  column's intermediate ProjectNode attr id is collapsed by project-merge, so the retired
  by-id reference dangled; recomputing from base columns has nothing fragile to reference.
- *Equivalence to the retired path for pass-through columns.* Old path was
  `π_returning( σ_{user where}( root ) )` where `root` already carries the body σ. New path
  is `π_{base-terms}( σ_{idPredicate}( joinNode ) )` with `idPredicate = userBase ∧
  bodyWhere` over the raw join. Same row set, same projected values. No regression for the
  previously-green pass-through cases (verified: `rjoin` delete-returning tests still pass).
- *Filter/timing independence after consolidation.* The shared
  `buildMultiSourceReturningProjection` takes `filtered` as a param and carries no timing.
  DELETE passes the `pre` idPredicate filter; UPDATE keeps the `post` EXISTS-over-capture
  filter; the dispatcher sets `'pre'`/`'post'` per op. Confirmed not coupled.
- *`returning *` and renamed columns.* `*` expands only over `analysis.outColumns` via
  `viewColToBaseRef` (view outputs only — hidden base columns excluded), aliased to each
  display name. Order/names match the sqllogic assertion.

**Checked — guards / safety:**
- *Encapsulation guard parity.* `guardTopLevelScope` fires per non-`*` RETURNING column
  (`buildReturningProjection`) → `returning pref` (hidden base col) rejected at plan time,
  before any row is deleted (sqllogic confirms the subsequent `cid=1` delete still finds
  its row). The WHERE is independently guarded in `decomposeDelete`.
- *Type safety.* The `rc as AST.ResultColumnExpr` cast in the shared helper is safe —
  `buildReturningProjection` only ever emits `{ type: 'column', ... }` entries (the `*` is
  pre-expanded). `stmt.returning!` is guarded by the dispatcher's non-empty check.

**Checked — hygiene / call graph / docs:**
- *Imports.* No dangling/unused imports after the three deletions —
  `RegisteredScope`/`ColumnReferenceNode`/`ProjectNode`/`Projection`/`FilterNode` all still
  used by the insert/decomposition paths; lint confirms.
- *Call graph.* `buildMultiSourceReturningProjection` is private with exactly two callers
  (the UPDATE and DELETE builders); each builder has exactly one caller (the dispatcher).
  No stray references to the deleted helpers anywhere in source (only this ticket and a
  historical completed ticket mention the old names).
- *Docs.* `docs/view-updateability.md` § RETURNING accurately reflects the new mechanism.

**Found & fixed (minor, in this pass):**
- The dispatcher's **function-level** docstring for the DELETE branch
  (`buildMultiSourceReturning` in `view-mutation-builder.ts`) still described the retired
  mechanism ("re-queries the view ... projected columns resolve naturally against the
  view"), inconsistent with the updated inline comment, the called function, and the docs.
  Rewrote it to the base-term-recompute language. Comment-only; re-ran lint (clean).

**Noted gap (not a defect, no ticket filed):**
- *Multi-row multi-source DELETE RETURNING ordering is not pinned.* All asserted DELETE
  cases match a single row via a single-column-PK predicate. This is orthogonal to the
  computed-column fix and pre-existing — it applies equally to the pass-through path that
  shipped earlier. No correctness risk: the projection is a plain `ProjectNode` over a
  `FilterNode` with no single-row assumption (N matching join rows → N projected rows,
  each recomputed). Only *ordering* of multi-row RETURNING output over a join delete is
  unasserted, and RETURNING output order is not contractually specified. Left documented;
  would only warrant a test if RETURNING ordering is later spec'd.

**Major findings:** none. **New tickets:** none.

## Validation

- `yarn workspace @quereus/quereus test` → 4366 passing, 9 pending.
- `yarn workspace @quereus/quereus run lint` → clean (twice — before and after the
  docstring fix).
- `yarn workspace @quereus/quereus run build` → clean.
- Scope unchanged: two-table single-column-PK inner joins. `> 2`-table, self-, and outer
  joins remain rejected at plan time (Phase 2b+). The fix corrects only the computed-column
  projection within the already-supported shape; no new join shape was silently accepted.
- `store` path not run (planner-side projection construction only; no storage code touched —
  the memory-vtab run is representative). A belt-and-suspenders `yarn test:store` could be
  run out-of-band.
