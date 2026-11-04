---
description: When the planner merges "col < :lo or col > :hi" into one multi-range constraint, it now keeps each bound's kind and gives the merged constraint an honest label, so a storage module can safely use placeholder bounds for an index lookup. The same merge also no longer drops a bound and returns extra rows.
architecture: docs/module-authoring.md#binding-capture
files:
  - packages/quereus/src/planner/analysis/constraint-extractor.ts   # BindingKind, RangeSpec, branchToRangeSpec, summarizeRangeBindings, tryCollapseToOrRange, extractBetweenConstraints
  - packages/quereus/src/vtab/best-access-plan.ts                   # public RangeSpec doc comment
  - packages/quereus/test/planner/constraint-extractor.spec.ts      # describe('OR → OR_RANGE collapse')
  - docs/module-authoring.md                                         # § Binding Capture
  - docs/optimizer.md                                                # § Current limitations
---

# OR_RANGE bounds carry their binding kind

An `OR_RANGE` constraint is what the planner builds when every branch of an OR is a range or equality on one column.

## What shipped

- **Per-bound kind.** Each `ranges[i].lower` and `ranges[i].upper` has `bindingKind` and `correlated`, copied from the branch constraint that fills it. The lamina storage module reads `bindingKind` under that exact name and value `'parameter'`.
- **Constraint summary.** The constraint's `bindingKind` is the shared kind of its bounds, or `'mixed'` when they differ or a bound has no kind. Its `correlated` is true when any bound's is, and false otherwise.
- **BETWEEN label.** `extractBetweenConstraints` sets `bindingKind: 'literal'` on both constraints, so `a between 1 and 5 or a = 10` stays `'literal'`.
- **Wrong-result fix.** A branch with a second constraint on an already filled bound slot declines the collapse, so the whole OR stays a residual filter. An equality needs both slots free. Before, the later constraint overwrote the earlier one and the dropped condition was never applied. These queries can now plan slower, but they return the right rows.
- **Plan change.** `admitSeekLeaf` Gate 4 in `rules/join/index-nested-loop.ts` now declines a seek leaf whose pushed `OR_RANGE` has a correlated bound. The plan uses another join strategy with the same rows.
- **Types.** `BindingKind` is a new named union in the planner-side file. The public `RangeSpec` in `vtab/best-access-plan.ts` deliberately doesn't declare the new fields, and filters reach modules by reference.

## Review findings

Reviewed from the diff of `ticket(implement): feat-or-range-bounds-carry-binding-kind`.

### Fixed in this pass

- **A documentation sentence was false.** `docs/module-authoring.md` said a `'parameter'` bound "is fixed for the prepared statement's life". Rebinding one prepared `select a from t where a < :lo or a > :hi` returned 0, 8, 10 for `:lo = 1, :hi = 7` and 0, 3, 10 for `:lo = 4, :hi = 9`. A module following that sentence could reuse a stale value. It now says the value holds for one execution and can change on a rebind, and that a `'correlated'` bound can change per outer row. The wrong wording came from the plan ticket.
- **`docs/optimizer.md` limitations bullet.** The new sentence sat directly before "Tracked by", so it read as tracked by the OR-to-UNION ticket, which is about something else, and it mentioned only "two bounds on the same side", not an equality plus a bound. It is now its own bullet covering both.
- **Stale ticket path in the same bullet.** `tickets/plan/2-or-to-union-rewriting.md` no longer exists. It now points to `tickets/backlog/known/4-or-to-union-rewriting.md`.
- **Public type comment.** The public `RangeSpec` declares `value: SqlValue`, but a placeholder bound arrives with `value: undefined`. A module author reading only that type would not know, so it now has a comment pointing at Binding Capture.

### Checked, no defect

These ran as a one-off script against the `dist` build of the implement commit, using `create table t (a integer primary key)` holding 0, 3, 6, 8, 10.

- **What a module receives.** A memory-module subclass recorded its `request.filters`. For `a < :lo or a > :hi` the filter has `bindingKind: 'parameter'`, `correlated: false`, and each bound has its kind, a `valueExpr` and `value: undefined`. The implementer's tests stop at the extractor, so this was the unverified link to lamina.
- **Gate 4, previously unverified at runtime.** With the debug log on, `select o.id, (select count(*) from e join (select * from d where d.a < o.x or d.a > 9) dd on dd.k = e.k) from o` logged `decline: seek leaf carries a correlated pushed constraint`, planned a hash join over the correlated seek, and returned the correct 1|2, 2|3, 3|1.
- **NULL placeholders.** `:lo = null, :hi = 7` returns 8, 10. `:lo = 1, :hi = null` returns 0. Both null returns no rows. `a = :p or a > 7` with `:p = null` returns 8, 10. A NULL bound does not match rows.
- **Wrong-result fix.** `(a > 7 and a > 5) or a < 1` returns 0, 8, 10. `(a = 8 and a > 5) or a < 1` returns 0, 8. `(a > :x and a > 5) or a < 1` with `:x = 7` returns 0, 8, 10. The legitimate two-sided branch `(a > 5 and a < 9) or a < 1` still returns 0, 6, 8.
- **Correlated seek on its own.** `(select count(*) from t where t.a < o.x or t.a > 9)` plans an index range seek and returns the correct counts.
- **By reading.**
  - Removing the "at least one bound" check is safe: `tryExtractOrBranches` and `tryCollapseToOrRange` both reject empty branches, and a non-range op returns null.
  - A nested `OR_RANGE` or `IN` inside an AND branch reaches the non-range arm and declines.
  - A branch's constraints on two tables that share a column index can't collapse, because the `allRelations.size !== 1` check rejects them first.
  - Every constraint reaching the collapse has a kind, so the `'mixed'` fallback for a missing kind is defensive only.
  - The other readers of the flags are `change-scope.ts` (`=` arm only) and `computeCoveredKeysForConstraints` (`=` and single-value `IN` only), and neither is affected.
- **Error handling and resources.** The change adds no I/O, state or error paths, so there is nothing to clean up.

### Tests

- **Kept all seven added tests.** Each pins a row of the plan's Expected table on logic with real branching, and the two residual tests reproduce the bug at the lowest layer.
- **Added none.** The checks above found no code defect, so there was no reproduction to add.
- **Not kept as logic tests.** The end-to-end queries above were one-off, since the unit tests pin the decision that caused the bug.

### Validation

- `yarn workspace @quereus/quereus run lint`: no errors.
- `yarn workspace @quereus/quereus test`: 11046 passing, 26 pending, 0 failing.
- Both ran before this pass's edits, which are two docs and one comment, and were not rerun afterwards.
- Not run: `yarn test:store`, and tests in other packages. `packages/quereus-store` has no `OR_RANGE` handling, so by reading it should see no difference, but this is unverified at runtime.

### Major, tripwires, accepted tradeoffs

- **Major:** none, so no tickets filed.
- **Tripwires:** none added.
- **Accepted-tradeoff `NOTE:`s:** none at these sites. The planner-side-only `RangeSpec` is a tradeoff the plan recorded and is left as is.
- **Source size, not acted on:** `constraint-extractor.ts` is 1746 lines (`wc -l`). This change adds little to it, and it doesn't serve this ticket's anchor.
- **Stale reference, not fixed:** the next bullet in `docs/optimizer.md` cites `tickets/plan/2-composite-index-advanced-seeks.md`. A filename search of `tickets/` and of the pruned-tickets ledger found no such ticket. It is outside this change, and I don't know whether the work landed or was renamed.
- **Parked elsewhere:** `collapseBranchesToIn` also drops `correlated`, tracked by `debt-or-in-collapse-drops-correlated-flag`.

## For the lamina board

- The lamina follow-up `feat-late-bound-or-range-claim-after-quereus-bump` needs a published quereus release before it can proceed.
- **Correlated bounds would be claimed unless lamina changes.** The follow-up lists "a correlated bound still declines" as a check, but lamina's current `isClaimableLateBound` accepts both `'parameter'` and `'correlated'`, and its `OR_RANGE` arm calls it. This comes from the plan-stage reading of the lamina repository, which this review did not re-check. Pass it on with the release.
- **Don't carry a parameter bound's value between executions.** See the corrected Binding Capture paragraph. Lamina's claim logic should be checked against it.
