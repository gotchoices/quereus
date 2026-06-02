description: Phase B3 — converged the decomposition put fan-out (`decomposition.ts`) onto the SAME plan-node backward-walk consumer the multi-source path uses. A shared `analyzeBodyLineage` (n-way) plans a view body once and reads its threaded `updateLineage`; `resolveBaseSite` is the shared per-site reader. Decomposition derives column→member routing + the anchor-only predicate gate from that lineage (retiring `buildViewColMap` + `collectColumnQualifiers`); the advertisement only disambiguates deferred shapes. Reviewed, build + lint clean, full suite green (4350 passing / 9 pending / 0 failing after one added regression test).
prereq:
files: packages/quereus/src/planner/mutation/backward-body.ts, packages/quereus/src/planner/mutation/decomposition.ts, packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/analysis/update-lineage.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/test/property.spec.ts, packages/quereus/test/lens-put-fanout.spec.ts, docs/view-updateability.md, docs/lens.md

## What shipped

`decomposition.ts` previously derived its backward decisions from AST analysis
(`buildViewColMap` projection map, `collectColumnQualifiers` base-qualifier scan in
`anchorPredicate`) rather than the threaded plan-node lineage the multi-source path
consumes. This ticket made single-source / multi-source / decomposition share **one**
backward-walk consumer.

### New shared surface
- `analysis/update-lineage.ts` — `resolveBaseSite(site)` (+ `ResolvedBaseSite`): the
  n-way per-`UpdateSite` reader, unwrapping `base` / outer-join-`null-extended` to its
  owning base relation. Subsumes the deleted multi-source-local `writableBaseSite`.
- `mutation/backward-body.ts` (NEW) — `analyzeBodyLineage(ctx, view)`: plans a view body
  once (`buildSelectStmt`), collects its `TableReferenceNode`s, reads
  `root.physical.updateLineage` via `resolveBaseSite`, returns `{ root, tableRefsById,
  viewColToBaseRef, columns: BackwardColumn[] }`. Source-count-agnostic. Also exports
  `collectTableRefs` (relocated from multi-source).

### Consumers converged
- `multi-source.ts` `analyzeJoinView` now calls `analyzeBodyLineage` and layers
  `JoinNode` / `joinScope` / per-side mapping on top; `writableBaseSite` + the private
  `collectTableRefs` are deleted; the `select *` reject moved before the shared read.
- `decomposition.ts` — `analyzeDecomposition` builds a `DecompShape` off
  `analyzeBodyLineage` + a `TableReferenceNode`-id→member map; `classifyColumn` routes
  each logical column off the lineage (identity base column → owning member), falling
  back to the advertisement only for the deferred shapes (computed-mapping / EAV /
  unbacked). `routeAssignment`, `routeInsertColumn`, and the lineage-driven
  `assertAnchorScoped` all decide off `classifyColumn`. `buildViewColMap` +
  `collectColumnQualifiers` retired. INSERT now plans the synthesized body once.

## Review findings

**Verdict: the refactor is correct and the acceptance gate (behavioral parity) holds.**
I read the implement diff first, reasoned through each converged path against the retired
code, then re-ran the gates. Build (tsc) clean, lint clean, full quereus suite **4350
passing / 9 pending / 0 failing** (was 4349 pre-review; +1 from a regression test I added).
`--grep decomposition` = 57 passing.

What I checked, by aspect:

- **Correctness / parity (multi-source).** `analyzeJoinView`'s rewrite preserves the
  `OutColumn` shape: `writable = sideIndex !== undefined && !bc.nullExtended`. Confirmed
  via `deriveJoinUpdateLineage` that an **inner** join never emits a `null-extended` site
  (only `left`/`right`/`full` do), so the extra `!nullExtended` guard is unreachable on
  the multi-source acceptance shape and behavior is byte-identical there. Family-B / 93.4
  / view-info suites green.
- **Correctness / parity (decomposition routing).** `classifyColumn` precedence (identity
  base column → `member.columns` mapping → EAV non-column projection → unbacked) mirrors
  the retired advertisement scan. Identity gate `inverse === undefined` correctly admits
  bare-column / rename projections and rejects invertible transforms to `computed-mapping`
  (read-only), matching the old `basisExpr.type !== 'column'` reject. Optional members are
  double-guarded (`presence !== 'mandatory' || nullExtended`). EAV columns (correlated
  subqueries, absent from `member.columns`) classify via the projection-non-column branch.
  All deferral diagnostics preserved verbatim where tests assert on them.
- **Type safety.** `ResultColumn` is exactly `{type:'all'} | ResultColumnExpr`, so
  `analyzeBodyLineage`'s `rc.type === 'all'` guard makes the subsequent
  `(rc as ResultColumnExpr).expr` cast sound.
- **Edge / error paths — ONE finding, fixed inline (minor).** The implementer's flagged
  gap #1: an unknown WHERE column (`delete from x.T where notacol = 1`) was rejected with
  `unsupported-decomposition-predicate` and the message "references a non-anchor
  decomposition member" — **factually wrong** for a column that is not a member at all,
  and inconsistent with the single-source / multi-source paths, which guard top-level
  WHERE refs via the shared `assertTopLevelViewColumns` → `unknown-view-column`
  encapsulation-leak guard. Decomposition had no such guard. **Fixed:** `assertAnchorScoped`
  now raises `unknown-view-column` ("'<name>' is not a column of the logical table", with
  the exposed-columns suggestion) for a name not in `shape.columns`, before the non-anchor
  deferral — matching the sibling paths. A real non-anchor member (`where b = 100`) still
  hits the unchanged deferral message. Added regression test
  `lens-put-fanout.spec.ts` "rejects a WHERE on an unknown column as an encapsulation leak".
- **Docs — ONE finding, fixed inline (minor).** `docs/view-updateability.md` Phase-B1
  callout still named the live consumer as `multi-source.ts` `writableBaseSite` (deleted
  this ticket). Updated to `update-lineage.ts` `resolveBaseSite`. The file-list entry and
  the `lens.md` / decomposition entries were already correctly updated by the implementer;
  every retired-symbol mention elsewhere is intentionally historical ("the retired X").
- **Resource cleanup / DRY / modularity.** No leaks (planner-only, no I/O). The new
  `backward-body.ts` is a clean single-purpose seam; the three pre-existing `collectTableRefs`
  variants (materialized-views, binding-extractor, change-scope) use different key schemes
  and are out of scope. `backward-body.ts`'s exported `collectTableRefs` is only consumed
  internally now (multi-source reads `tableRefsById` from the shared result) — harmless,
  not worth narrowing.
- **Performance.** `classifyColumn` is linear over a small column/member set; INSERT now
  plans the get body once (previously advertisement-only) — the same body the lens read
  path already plans, so no new failure surface. Acceptable.

### Findings NOT fixed (with reasons)

- **Coverage: non-identity columnar mappings (implementer gap #3).** Every test
  advertisement uses identity `colMap('a','a')`; the lineage-driven `computed-mapping`
  classification of a transform/composite `member.columns` basis is reasoned-equivalent to
  the retired AST reject but unproven by goldens. A regression there would silently flip a
  column's writability. **Filed** as backlog ticket
  `decomposition-non-identity-columnar-mapping-coverage` (also captures the self-decomposition
  `memberByTableId` ambiguity, gap #4, and the robustness-of-match observation). Not a defect
  — purely missing coverage — hence backlog, not fix.
- **Dead-path message divergence in `routeAssignment` (gap #2).** The retired step-3
  "computed projection" sub-branch is unreachable in a synthesized body (a non-column
  projection arises only from an EAV subquery — needs an EAV member, caught as `eav` — or a
  `member.columns` non-identity mapping, caught earlier as `computed-mapping`). Confirmed
  unreachable; no action.
- **Multi-source parity is by-construction (gap #5).** Validated by the full Family-B /
  93.4 / view-info suites rather than a byte-level analysis diff; I traced the `OutColumn`
  shape mapping by hand and it matches. No structural concern.
- **`view-complement.ts` not edited (gap #6).** Correct scope call — all routing/gate
  decisions are per-output-column → `updateLineage` is the natural source; the complement's
  hidden-columns/residual surface was not needed.
- **`test:store` (LevelDB) not run (gap #7).** Planner-only change; consistent with the
  B1/B2 handoffs. Left for CI / a human.

### Files changed in this review pass
- `src/planner/mutation/decomposition.ts` — `assertAnchorScoped` encapsulation-leak guard.
- `test/lens-put-fanout.spec.ts` — unknown-WHERE-column regression test.
- `docs/view-updateability.md` — stale `writableBaseSite` → `resolveBaseSite` reference.

## End
