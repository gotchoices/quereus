description: Query optimizer per-node cost estimates now store self-cost only (children summed once in getTotalCost), so deeply nested plans no longer get exponentially inflated costs. Reviewed and shipped.
files: packages/quereus/src/planner/nodes/plan-node.ts, packages/quereus/src/planner/nodes/sort.ts, packages/quereus/src/planner/nodes/filter.ts, packages/quereus/src/planner/nodes/aggregate-node.ts, packages/quereus/src/planner/nodes/recursive-cte-node.ts, packages/quereus/src/planner/validation/plan-validator.ts, packages/quereus/test/planner/cost-additivity.spec.ts, docs/optimizer.md
----

## Summary

Adopted the **self-cost-only** convention: `PlanNode.estimatedCost` stores only a
node's own incremental cost; `PlanNode.getTotalCost()` is the sole place children are
summed (walks `getChildren()`, memoized per instance). ~26 node constructors that
previously folded `child.getTotalCost()`/child `.estimatedCost` into their own
`estimatedCost` were rewritten to keep the residual self-cost only. The recursive-CTE
in-place child mutator (`setRecursiveCaseQuery`) invalidates the memo. Guards added:
`validateCostAdditivity(plan)` (debug/test) and a static source-scan test. Docs updated
in `docs/optimizer.md` § Self-cost-only convention.

## Review findings

**Verdict: implementation sound. No major/blocking findings. One tripwire noted inline.**

Checked, adversarial pass over the full implement diff (911a9b4d), every touched file
plus the ones it should have touched (all `planner/nodes/*`, cost module, validator,
docs):

- **Correctness of the convention (double-count removal).** ✅ Every rewritten constructor
  drops the folded child term and keeps a plausible self-cost. Spot-verified joins,
  aggregates, filter, sort, distinct, passthroughs, recursive-cte against `getChildren()`
  membership — no child cost is folded anywhere. `filter` correctly counts BOTH children
  (source + predicate); `sort` correctly excludes the sort-key expressions (they are
  children). Cost fns (`sortCost`/`filterCost`/`aggregateCost`) exist and are applied with
  correct signatures.
- **Implementer's flagged gaps (handoff items 1–7).** Re-checked each. SortNode (#1) and
  AggregateNode (#2) modeling choices are correct per the universal rule + the
  `getChildren()` membership check — confirmed, not a defect. `estimatedCostOverride` audit
  (#3) and untouched-nodes claim (#4) verified by independent grep: no node file outside
  `plan-node.ts` reads `getTotalCost(`/child `.estimatedCost` (except the allowed vtab-leaf
  `indexInfoOutput.estimatedCost`). The static guard (#5) is a whole-file scan — accepted
  tradeoff, documented in the test. QuickPick-stability (#6) and cost-magnitude/goldens (#7)
  concerns are floors, not defects.
- **Memoization safety.** ✅ Verified the only in-place child mutator in the codebase is
  `RecursiveCTENode.setRecursiveCaseQuery` (grep of `_totalCostCache`/`invalidateTotalCostCache`
  + manual scan for child reassignments). It self-invalidates, and its sole caller
  (`building/with.ts`) invokes it immediately after construction, before the node is attached
  to any parent — so no ancestor memo can go stale. The additivity guard is tautological
  against a stale memo (both sides read the same cache), so it does NOT catch stale memos; the
  dedicated recursive-CTE invalidation test does. Adequate for the one mutation path that
  exists.
- **Guards / validator.** ✅ `validateCostAdditivity` is debug/test-only (not on the hot
  `validatePhysicalTree` path, as intended). Its real value is NaN/negative/infinite self-cost
  detection, not the tautological additivity equality — acceptable.
- **Lint + tests.** ✅ `yarn workspace @quereus/quereus lint` clean (eslint + tsc on tests,
  exit 0). Full `yarn workspace @quereus/quereus test` — **6537 passing, 9 pending, exit 0**,
  including the new 6-test `cost-additivity.spec.ts` and the pre-existing
  `plan-node-traversal.spec.ts` additivity test.
- **Docs.** ✅ `docs/optimizer.md` § Self-cost-only convention added; accurately describes
  the convention, memoization, invalidation, and both guards. No other doc references the old
  fold-into-self model.

### Minor fix applied in this pass

- **filter.ts** — added a `NOTE:` tripwire (see below). No other inline fixes needed.

### Tripwires (conditional; parked, not ticketed)

- **filter predicate cost no longer scales with row count.** The pre-fix formula multiplied
  the predicate's cost by source rows (`rows * predicate.getTotalCost()`); under self-cost-only
  the predicate subtree cost is added **once** as a child. An expensive predicate over a large
  input is now under-weighted. Fine now (consistent with the convention, which cannot multiply
  a child's cost); only matters if predicate complexity ever needs to drive plan choice — then
  fold a per-row predicate factor into `filterCost()` rather than re-summing the child.
  → Parked as a `NOTE:` at `packages/quereus/src/planner/nodes/filter.ts` (the FilterNode
  constructor).
- **getTotalCost memo assumes no ancestor computes cost before a descendant's in-place
  mutation.** True today (only `setRecursiveCaseQuery` mutates, and it runs pre-parenting).
  Already documented in `plan-node.ts` (`getTotalCost` doc) and `recursive-cte-node.ts`
  (`setRecursiveCaseQuery` comment). If a future node gains an in-place child setter, it must
  call `invalidateTotalCostCache()` AND ensure no ancestor has cached first. No new marker
  added — the existing comments cover it.

### Not found / explicitly clear

- No double-count residue in any node constructor (grep + manual). No stale-memo path for the
  single existing mutation. No golden/EXPLAIN test asserts a node cost value that the magnitude
  changes would break (implementer grep re-confirmed). No lint/type regressions.

## Pre-existing failure (unrelated, already triaged)

The full-suite run flagged a flaky `@quereus/sync-coordinator` test (`StoreManager > disk
eviction > should clear eviction candidates on shutdown`) that passes on isolated re-run;
different package, no planner code path. Already recorded in `tickets/.pre-existing-error.md`
by the implement stage (commit 17c9a207 triaged it). Not re-reported here.
