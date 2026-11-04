---
description: When the planner merges "col = outer.x or col = 5" into one IN list, it loses the mark saying the value depends on an outer row, so a later join optimization that checks that mark can't see it. Set the mark on the merged constraint.
files:
  - packages/quereus/src/planner/analysis/constraint-extractor.ts       # collapseBranchesToIn builds the merged constraint without `correlated`
  - packages/quereus/src/planner/rules/join/index-nested-loop.ts        # admitSeekLeaf Gate 4 reads `correlated` on every pushed constraint
tradeoffs: No wrong answer or bad plan has been observed from this, and the one query tried never reached the affected check, so it may stay theoretical until a query plans a seek on the merged IN under a join.
---

# OR-to-IN collapse drops the correlated flag

`extractBinaryConstraint` and `extractInConstraint` both set `correlated: true` when a value references a column outside the constrained table. `collapseBranchesToIn` builds its merged `IN` constraint without copying that flag, so `d.a = o.x or d.a = 95` carries no `correlated` even though its seek keys vary per outer row.

`feat-or-range-bounds-carry-binding-kind` fixes the same omission for `OR_RANGE`.

Readers of the flag:

- `admitSeekLeaf` Gate 4 in `index-nested-loop.ts` declines a seek leaf that has a correlated pushed constraint, because that leaf is already serving an enclosing query per outer row. A merged correlated `IN` would pass this gate.
- `computeCoveredKeysForConstraints` is unaffected. It only treats a single-value `IN` as covering a key, and a merged `IN` has at least two values.

Expected: the merged constraint's `correlated` is true when any branch constraint's is.

Evidence: found by reading the code. One query, `select count(*) from e join d on d.k = e.k where d.a = o.x or d.a = 95` under a correlated scalar subquery, planned a filter over a merge join, with no seek leaf, so Gate 4 was not reached. Its rows were correct.
