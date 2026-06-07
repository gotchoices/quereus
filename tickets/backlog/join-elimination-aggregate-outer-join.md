description: Extend `ruleJoinEliminationUnderAggregate` (the Aggregate-anchored variant of FK→PK join elimination) to handle OUTER (left/right) joins, not just inner. Today it is inner-only, so a `count(*)` (or any cardinality-only aggregate not referencing the non-preserved side) over an FK→PK LEFT join is never collapsed to zero join ops — the join survives as a physical hash/merge join. This is the missing piece for the "zero join ops" headline that `existence-flag-pruning-aggregate-anchored` assumed but could not deliver (existence flags are only valid on outer joins, yet aggregate-elimination is inner-only, so pruning a flag under an aggregate re-enables physical join selection but never elimination).
files: packages/quereus/src/planner/rules/join/rule-join-elimination.ts (ruleJoinEliminationUnderAggregate — currently `if (join.joinType !== 'inner') return null;`), packages/quereus/src/planner/rules/join/rule-join-existence-pruning.ts (the prune that flips an existence join flag-free, then wants this elimination to fire), packages/quereus/test/optimizer/rule-join-existence-pruning.spec.ts (the aggregate-anchored tests currently assert `joinCount === 1` for the count(*) case — would become `=== 0`)
----

## Problem

`ruleJoinElimination` (the `ProjectNode` anchor) eliminates an FK→PK
`left`/`right`/`inner` join whose non-preserved side is unreferenced. Its
Aggregate sibling `ruleJoinEliminationUnderAggregate` restricts itself to
`inner` joins:

```ts
const { join, chain } = walk;
// Only inner-eliminable shapes — see `ruleJoinElimination` notes.
if (join.joinType !== 'inner') return null;
```

with the comment "outer joins reduce to inner in this context only when both
sides demand attrs, which we'd have rejected already." That rationale is worth
re-examining: a `count(*)` over `L LEFT JOIN R` with an FK→PK-aligned
equi-condition is a clean elimination candidate that the inner-only gate blocks.

## Why outer-join elimination under a cardinality aggregate is sound

For `L LEFT JOIN R` where the equi-condition is FK→PK aligned (each L row
matches at most one R row) and no group key / aggregate argument references R:

- LEFT join preserves every L row regardless of match (matched → 1 row;
  unmatched → 1 null-padded row), and FK→PK guarantees ≤1 match, so
  `|L LEFT JOIN R| == |L|` **always**.
- Therefore `count(*)` (and any aggregate whose value depends only on
  cardinality / the L side) over the join equals the same aggregate over L
  alone, and eliminating R (returning L) is correct.
- Unlike the inner case, this needs **neither** a NOT-NULL FK **nor** a
  row-preserving path to R's base table: a null FK or a filtered R simply
  null-pads the L row instead of dropping it, so cardinality is unchanged. The
  existing `tryEliminate` already skips those two extra checks for non-inner
  join types, so the FK→PK alignment check it performs is exactly the right (and
  sufficient) gate for the LEFT case.

`right` joins are the mirror image (eliminate the left/non-preserved side).
`full` joins are out of scope (both sides preserved). The demand gate
(`usesRight` / `usesLeft`) already prevents eliminating a side the aggregate
reads.

## Expected behavior

- `select count(*) from orders left join customers on orders.customer_id = customers.id`
  (FK→PK, customers otherwise unreferenced) → **zero join ops** (the join is
  eliminated; the aggregate runs over `orders` alone), rows byte-identical to
  the un-eliminated baseline.
- Combined with `join-existence-pruning-aggregate`:
  `select count(*) from orders left join customers on … exists right as hasC`
  → prune the unused `hasC` flag (flag-free LEFT join), then this rule
  eliminates the join → zero join ops. This is the headline cascade the
  existence-pruning ticket described but could not achieve on its own.
- A non-FK left join, or one whose non-preserved side is referenced by an
  aggregate argument / group key, is **not** eliminated (unchanged).

## Use cases / validation

- Cardinality-only aggregate (`count(*)`) over an FK→PK left join → eliminated.
- Aggregate that references the non-preserved side (`sum(customers.x)`) → retained.
- `group by` on a non-preserved-side column → retained.
- Nullable FK left join → still eliminated (LEFT keeps unmatched rows), distinct
  from the inner case which requires NOT-NULL.
- Result equality vs the rule-disabled baseline across all shapes.
- Re-examine the existing inner-only comment and the test suite for any
  golden-plan snapshots that would shift when outer joins start eliminating
  under aggregates (measure the blast radius before committing).

## Note

Pure optimization — the current inner-only behavior is correct, just less
optimal. When this lands, update the `aggregate-anchored pruning` tests in
`rule-join-existence-pruning.spec.ts` (the `count(*)` case currently pins
`joinCount === 1` with a comment pointing here; it should become `=== 0`) and
drop the "does not cascade to elimination" caveat from the
`ruleJoinExistencePruning` entry in `docs/optimizer.md`.
