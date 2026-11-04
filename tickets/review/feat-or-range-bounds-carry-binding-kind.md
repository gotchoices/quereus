---
description: When the planner merges "col < :lo or col > :hi" into one multi-range constraint, it now keeps each bound's kind and gives the merged constraint an honest label, so a storage module can safely use placeholder bounds for an index lookup. The same merge also no longer drops a bound and returns extra rows.
architecture: docs/module-authoring.md#binding-capture
files:
  - packages/quereus/src/planner/analysis/constraint-extractor.ts   # BindingKind, RangeSpec, branchToRangeSpec, summarizeRangeBindings, tryCollapseToOrRange, extractBetweenConstraints
  - packages/quereus/test/planner/constraint-extractor.spec.ts      # describe('OR → OR_RANGE collapse')
  - docs/module-authoring.md                                         # § Binding Capture
  - docs/optimizer.md                                                # § Current limitations, OR predicate bullet
---

# OR_RANGE bounds carry their binding kind

An `OR_RANGE` constraint is what the planner builds when every branch of an OR is a range or equality on one column.

## What changed

- **Per-bound kind.** Each `ranges[i].lower` and `ranges[i].upper` now has `bindingKind` and `correlated`, copied from the branch constraint that fills it. The lamina storage module reads `bindingKind` under that exact name and value `'parameter'`.
- **Constraint summary.** The constraint's `bindingKind` is the shared kind of its bounds, or `'mixed'` when they differ or a bound has no kind. Its `correlated` is true when any bound's is, and false otherwise. Previously it was always `'literal'`, with `correlated` unset.
- **BETWEEN label.** `extractBetweenConstraints` now sets `bindingKind: 'literal'` on both constraints, so `a between 1 and 5 or a = 10` stays `'literal'`.
- **Behaviour change (wrong-result fix).** A branch with a second constraint on an already filled bound slot now declines the collapse, so the whole OR stays a residual filter. An equality needs both slots free. Before, the later constraint overwrote the earlier one and the dropped condition was never applied. These queries used to return extra rows (the 6) and can now plan slower, but they return the right rows.
- **Code shape.** The branch-building loop moved into `branchToRangeSpec`. I removed its "at least one bound" check because it could not fire: empty branches already decline earlier.
- **Types.** `BindingKind` is a new named union in the planner-side file. The public `RangeSpec` in `vtab/best-access-plan.ts` is deliberately unchanged, and filters reach modules by reference.

## Validation

- `yarn workspace @quereus/quereus run lint` printed no errors. `yarn workspace @quereus/quereus test` gave 11046 passing, 26 pending, 0 failing (11039 passing before the change).
- On a fresh `dist` build with `create table t (a integer primary key)` holding 0, 3, 6, 8, 10:
  - `where (a > 7 and a > 5) or a < 1` returns 0, 8, 10.
  - `where (a = 8 and a > 5) or a < 1` returns 0, 8.
  - `where a < :lo or a > :hi` with `:lo = 1`, `:hi = 7` returns 0, 8, 10, so placeholder bounds still seek correctly end to end.
- No existing plan test changed.

## Tests added

All are in `describe('OR → OR_RANGE collapse')` and cover the plan's Expected table.

| Test | Verifies |
| --- | --- |
| all-parameter bounds → parameter | `a < :lo or a > :hi`: both bounds and the constraint are `'parameter'`, `correlated` false |
| literal and parameter bounds → mixed | `a < 10 or a > :hi`: per-bound kinds differ, constraint is `'mixed'` |
| a correlated bound marks that bound and the constraint | `a < u.x or a > 5`: bound `correlated: true`, constraint `'mixed'` and `correlated` true |
| equality branch gives both of its bounds the same kind | `a = :p or a > 5`: lower and upper are `'parameter'`, constraint `'mixed'` |
| all-literal bounds including BETWEEN → literal | `a between 1 and 5 or a = 10`: every bound and the constraint are `'literal'` |
| (a>7 AND a>5) OR a<1 | Reproduces the bug: no constraints, residual predicate present |
| (a=8 AND a>5) OR a<1 | Reproduces the bug for an equality plus a bound on one slot: same result |

## Known gaps and points for the reviewer

- **Gate 4 reached by reading only.** `admitSeekLeaf` Gate 4 (`rules/join/index-nested-loop.ts`, `if (c.correlated === true)`) will now decline a seek whose pushed `OR_RANGE` has a correlated bound. That matches the gate's stated purpose, and the plan falls back to another join strategy with the same rows. No existing test exercises this path and I did not construct one, so it is unverified at runtime.
- **The residual test is at extractor level.** The end-to-end query check above was a one-off script and is not kept as a logic test, because the unit tests pin the decision that caused the bug.
- **Not run:** `yarn test:store`. `yarn lint` and `yarn test` across the other packages were also not run. Only `@quereus/quereus` was run, as the ticket specified.
- **Parked elsewhere:** `collapseBranchesToIn` also drops `correlated`, tracked as `debt-or-in-collapse-drops-correlated-flag`.

## For the lamina board

- The lamina follow-up `feat-late-bound-or-range-claim-after-quereus-bump` needs a published quereus release before it can proceed.
- **Correlated bounds would be claimed unless lamina changes.** The follow-up lists "a correlated bound still declines" as a check, but lamina's current `isClaimableLateBound` accepts both `'parameter'` and `'correlated'`, and its `OR_RANGE` arm calls it. Pass this on with the release.
