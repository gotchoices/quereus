description: Accept recursive-CTE `on-commit-incremental` MV bodies by classifying the whole MV as `'global'` so any source mutation triggers a full `rebuildBacking` at COMMIT (correctness-first whole-MV recompute; the proven manual-refresh path). Removes the create-time recursive rejection; true semi-naïve/DRed delta evaluation stays deferred to `materialized-view-recursive-semi-naive-delta`.
files: packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/planner/building/materialized-view.ts, packages/quereus/test/logic/52-materialized-views-incremental.sqllogic, docs/materialized-views.md, docs/incremental-maintenance.md
----

> **⚠ Superseded (2026-05-29) — feature removed.** Materialized views are being consolidated to a single **row-time** model by `materialized-view-rowtime-only-consolidation` (plan): the `manual` and `on-commit-incremental` refresh policies and the post-commit divergence / self-heal subsystem are removed. The work archived here is retained as historical record only.

## What shipped

Two edits, no new evaluation machinery (implement commit `df1d3f6c`):

- **Build-time gate** (`planner/building/materialized-view.ts`):
  `rejectUnsupportedIncrementalBody` no longer throws for
  `select.withClause?.recursive`. The bag-distinguishing set-op branch is
  unchanged; recursive eligibility now resolves in `compile()` at create time.
- **`compile()` recursion short-circuit** (`core/database-materialized-views.ts`):
  after the empty-source guard and **before** the `findAggregate`/join branches,
  `containsNodeType(analyzed, PlanNodeType.RecursiveCTE)` routes every collected
  source ref to `{ kind: 'global' }`. The residual loop already `continue`s on
  `'global'`; the subscription `apply` already routes
  `globalRelations.size > 0` → `rebuildBacking` + `markBackingRebuilt`.

Docs (`docs/materialized-views.md`, `docs/incremental-maintenance.md`) updated to
list recursive CTEs as *accepted-but-global*. Deferred true-delta work remains in
`tickets/backlog/materialized-view-recursive-semi-naive-delta.md` (confirmed
present).

## Review findings

### Scope of the review
Read the implement diff (`df1d3f6c`) with fresh eyes before the handoff: the
`compile()` short-circuit, the gate relaxation, the §7/§23/§24 sqllogic edits, and
the docs diff. Traced the routing end-to-end against live code — the recursive
plan-node shapes, `optimizeForAnalysis`' pass cutoff, the rule registry, and the
delta-executor global path. Aspect sweep: correctness, SPP/DRY, type-safety, error
handling, resource cleanup, maintainability, performance. Ran build, eslint, and
the full quereus suite (`yarn test`) — all green (3793 passing, 9 pending, 0
failing) before and after my inline test addition.

### Correctness — verified sound (against live code, not the handoff's word)
- **The walk reaches the real sources and excludes the self-reference.**
  `CTEReferenceNode.getChildren()` → `[this.source]` (the `RecursiveCTENode`);
  `RecursiveCTENode.getChildren()` → `[baseCaseQuery, recursiveCaseQuery, …]`, so
  both `containsNodeType` and `collectTableRefs` descend into base *and* recursive
  cases. The self-reference is an `InternalRecursiveCTERefNode extends
  ZeroAryRelationalBase` — not a `TableReferenceNode` and child-less — so
  `collectTableRefs` correctly omits it; the dependency set is exactly the real
  sources.
- **The `RecursiveCTE` node survives the analysis pass.** `optimizeForAnalysis`
  runs `executeUpTo(PassId.Structural)`; a grep of `planner/rules/` for
  `RecursiveCTE|InternalRecursiveCTERef|CTEReference` returns **zero** hits, so no
  rule rewrites/lowers the recursive node before the gate reads it.
- **Global routing fires independent of capture specs.** In `delta-executor.ts`
  the per-relation loop adds a `binding.kind === 'global'` relKey to
  `globalRelations` and the trigger is `changedBases.has(base)` (driven by the
  subscription's `dependencies`, themselves derived from `relationToBase`), *not*
  by captured per-row tuples. So an INSERT/UPDATE/DELETE to any source fires the
  rebuild even though the recursive branch registers no `CaptureSpec`s (correct:
  `rebuildBacking` re-reads sources from scratch via `collectBodyRows`).
- **Precedence is correct and ordering-guarded.** The recursion branch precedes
  `findAggregate`/join, so a recursive body whose outer query aggregates or joins
  is classified global rather than mis-rejected. §24 (`select count(*) from r`)
  empirically guards this: if recursion detection ever regressed, §24's create
  would throw "whole-table aggregate" instead of succeeding — a load-bearing
  regression sentinel that covers the implementer's "detection fragility" note
  more than adequately.
- **Empty-source recursive bodies still reject.** The size-0 guard runs before the
  recursion branch (§7 `mv_rec_nosrc` → "at least one source table").

### Minor — fixed inline (this pass)
- **Late-bag `union all` edge was documented but untested — now locked in.** Added
  **§25** to `52-materialized-views-incremental.sqllogic`: a `union all` recursive
  body that is duplicate-free at create (chain 1→2→3) succeeds, then an INSERT that
  makes (1,3) both base-present and recursively-derived turns the fixpoint into a
  bag. The COMMIT global rebuild hits the backing "must be a set" contract, Tier-1
  recovery re-runs the same body and fails again → **Tier-2 `diverged`** (reads
  error). The test asserts both the diverged read *and* that a subsequent explicit
  `refresh` re-hits "must be a set". Behavior empirically confirmed before landing;
  it is loud and correct (a recompute cannot silently dedup a `union all` bag) and
  differs from the per-binding path's silent-dedup limitation.

### Observations — no action needed
- **`agg = findAggregate(analyzed)` is computed then unused on the recursive
  branch.** A one-time create-time waste only; reordering would tangle the
  else-if. Left as-is.
- **Cascade with a recursive MV (recursive MV reading another MV's backing, or a
  dependent layered on a recursive MV) is untested for recursion specifically.**
  Verified low-risk by reading: the cascade trigger is the source-agnostic
  `isGloballyChanged?.(base)` path in `delta-executor.ts` (already reviewed under
  `materialized-view-incremental-cascading-convergence`); a recursive MV's rebuild
  marks `globallyChangedBacking` like any other. Left untested — out of scope for
  this whole-MV-global ticket.
- **Cycles.** A `union`/distinct recursive body over a cyclic graph terminates at
  the fixpoint; a `union all` body over a cycle loops unboundedly — generic
  recursive-query behavior, not MV-specific. Out of scope.
- **Performance foot-gun is intended.** Every source commit re-derives the whole
  fixpoint; the cost-fallback ratio is bypassed (a `'global'` binding never reaches
  `getChangedTuples`/`getRowCount`). Documented; the per-row fast path is the
  deferred ticket's job.

### Docs — verified current
`materialized-views.md` (eligibility lists recursive as accepted-but-global,
removed from the "Rejected up front" list, `union all` late-bag note, roadmap
"Incremental refresh" bullet marks recursive *delivered (global-rebuild)*) and
`incremental-maintenance.md` (the `'global'` recursive exception in the bindings
wrinkle) both match the shipped behavior. The cross-link anchor
`#eligibility-checked-at-create-time` resolves to the live heading.

### Major — none
No correctness, type-safety, or resource-cleanup defects found; no new tickets
filed. True incremental delta evaluation (semi-naïve insert + DRed delete) remains
correctly deferred to `materialized-view-recursive-semi-naive-delta`.
