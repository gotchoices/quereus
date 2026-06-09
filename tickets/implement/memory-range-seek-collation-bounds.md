description: The memory vtab range-seek path filters range bounds (and prefix-equality keys in the prefix-range plan) with a BINARY comparator, ignoring the index column's declared collation. As a result, a non-BINARY range/prefix seek would under-fetch case/space variants, so the planner conservatively DECLINES every non-BINARY range seek (falls back to a scan + residual). Correct results, but a missed optimization. A real fix threads the index column collation into the bound comparison + early-termination so non-BINARY range seeks become usable.
files:
  - packages/quereus/src/vtab/memory/layer/plan-filter.ts                 # planAppliesToKey — bound compares use compareSqlValues (BINARY), not the index collation
  - packages/quereus/src/vtab/memory/layer/scan-layer.ts                  # range walk seek-start + early-termination also BINARY-compare bounds
  - packages/quereus/src/vtab/memory/layer/scan-plan.ts                   # ScanPlanRangeBound construction; where a per-column collation would need to flow in
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts  # classifyConstraintCover — the conservative "decline all non-BINARY range seeks" guard that this ticket would let relax
  - packages/quereus/test/vtab/maintenance-prefix-delete.spec.ts          # documents the existing BINARY-prefix-compare limitation (NOCASE leading base-PK)
----

# Memory range/prefix seek bounds ignore index collation

## Background

A range or prefix-range index seek in the memory vtab walks the secondary/primary BTree
in the index's **declared collation order** (the tree comparator is collation-aware), but
then:

- filters each visited key against the range bounds with `compareSqlValues` — the **BINARY**
  comparator — in `planAppliesToKey` (`plan-filter.ts`), and
- early-terminates the walk in `scanLayer` (`scan-layer.ts`) using a **BINARY** compare of
  the leading column against the terminating bound, and
- in the prefix-range plan, matches the equality **prefix** columns with a BINARY compare too.

For a BINARY-ordered index this is consistent. For a non-BINARY index (e.g. `NOCASE`) the
BINARY bound filter disagrees with the NOCASE walk order: e.g. for a `NOCASE` index over
`'BOB'`, `'Bob'`, a seek for `name >= 'bob'` positions correctly in NOCASE order but then
the BINARY bound filter rejects `'BOB'`/`'Bob'` (uppercase < lowercase in BINARY), so the
seek **under-fetches** and can even early-terminate prematurely. The same hazard is already
documented for the prefix-delete path in `maintenance-prefix-delete.spec.ts`, which only
constructs "binary-homogeneous" slices to stay sound.

## Current mitigation (correctness, not performance)

`classifyConstraintCover` in `rule-select-access-path.ts` was made conservative: a **range**
(non-equality) seek is classified `MATCH` only when both the predicate's effective collation
and the index collation are `BINARY`; any non-BINARY collation (even one that matches the
index) is `MISMATCH_UNSAFE`, so the access path declines the seek and falls back to a
sequential scan + residual. This is always correct — the residual re-applies the original
predicate — but it forgoes the index for legitimately-collation-matched non-BINARY ranges
(e.g. a `NOCASE` column `BETWEEN` over a `NOCASE` index).

Equality seeks are unaffected: `planAppliesToKey`'s equality branch uses the collation-aware
`keyComparator`, so a NOCASE equality seek is correct and remains enabled.

## Desired behavior

Thread the index column's declared collation into the range-bound comparison and the walk's
early-termination (and the prefix-equality compare in the prefix-range plan) so that a
non-BINARY range/prefix seek visits exactly the collation-correct window. Once the runtime
honours non-BINARY range bounds, relax the `classifyConstraintCover` range guard to allow
`MATCH` when the predicate's effective collation equals the index collation (mirroring the
equality arm), restoring index usage for collation-matched non-BINARY ranges.

## Acceptance

- A `NOCASE` (and `RTRIM`) column/predicate range or `BETWEEN` over a matching-collation index
  uses the index seek and returns the same rows as the equivalent sequential scan.
- The prefix-range plan with a non-BINARY leading column returns correct rows via a seek.
- Existing collation tests (`test/logic/06.4.2-collation-extras.sqllogic`,
  `test/logic/03-expressions.sqllogic`) continue to pass; results are unchanged, only plans
  improve.
