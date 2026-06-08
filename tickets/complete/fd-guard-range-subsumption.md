---
description: `GuardClause` extended with a `range` variant so partial-index / implication-CHECK predicates like `WHERE age >= 18` can be discharged by stronger filters like `WHERE age >= 21`.
files:
  packages/quereus/src/planner/nodes/plan-node.ts
  packages/quereus/src/planner/util/fd-utils.ts
  packages/quereus/src/planner/analysis/partial-unique-extraction.ts
  packages/quereus/src/planner/analysis/check-extraction.ts
  packages/quereus/src/planner/analysis/predicate-shape.ts
  packages/quereus/test/optimizer/conditional-fds.spec.ts
  docs/optimizer.md
---

## Summary

`GuardClause` (in `plan-node.ts`) now has a `range` variant whose shape mirrors
the existing `DomainConstraint.range` shape: `{ column, min?, max?,
minInclusive, maxInclusive }`. The recognizers in
`partial-unique-extraction.ts` and `check-extraction.ts` produce range guards
from `<`/`<=`/`>`/`>=`/`BETWEEN` shapes, and `fd-utils.ts:clauseEntailed` can
discharge a range guard when a filter's intersected range on the same column
(or any EC peer / binding-shared column) is a subset of the guard's range.

`NOT BETWEEN`, NULL literal bounds, and symbolic/parameter bounds remain
unrecognized.

## Files changed

- **`plan-node.ts`** — added `range` to the `GuardClause` union and expanded
  the surrounding doc comment.
- **`predicate-shape.ts`** — added a shared `flipComparison(op)` helper
  (operand-swap variant; the same-named helper in `predicate-normalizer.ts`
  does predicate *negation*, distinct semantics).
- **`partial-unique-extraction.ts`** — `recognizeClause` dispatches to new
  `recognizeRange` and `recognizeBetween`. NULL literal bounds drop silently.
- **`check-extraction.ts`** — `recognizeNegatedGuard` extended for
  implication-form disjuncts `col < lit` / `col <= lit` / `col > lit` /
  `col >= lit` (and their operand-flipped twins). Local `flipComparison`
  copy removed in favor of the shared helper.
- **`fd-utils.ts`** —
  - `guardClauseEquals`, `projectClause`, `shiftClause` all gain `range`
    arms.
  - `PredicateFacts` gains `rangeBounds: Map<number, FilterRange>`.
  - `buildPredicateFacts` recognizes `BinaryOpNode` with `<`/`<=`/`>`/`>=`
    (operand-flip on `lit op col`) and `BetweenNode` (skipping `not === true`).
  - `clauseEntailed` `range` arm calls `filterRangeSubsetOfGuardRange`
    across every `candidateColumn`.
- **`docs/optimizer.md`** (added in review) — `GuardClause` type listing,
  implication-form CHECK table, partial-UC table, and the
  `predicateImpliesGuard` recognized-shapes paragraph all updated to reflect
  the new range surface.

## Validation run

- `yarn workspace @quereus/quereus run typecheck` — clean.
- `yarn workspace @quereus/quereus run lint` — clean.
- `yarn workspace @quereus/quereus run test` — 3085 passing, 2 pending,
  0 failing (43s).

## Review findings

**What was checked:** full diff of plan-node.ts, predicate-shape.ts,
partial-unique-extraction.ts, check-extraction.ts, fd-utils.ts, and the
conditional-fds.spec.ts test additions; soundness of range semantics
(NULL handling, inclusivity at boundary, intersection ties); correctness of
the negation table in implication-form CHECK; per-helper coverage of the
`range` variant in `guardClauseEquals` / `projectClause` / `shiftClause`;
DRY across the three places that flip a comparison operator;
`docs/optimizer.md` for type-block / table / paragraph drift; full test
suite + lint + typecheck.

**Minor — fixed inline:**

- **DRY**: `buildPredicateFacts` in `fd-utils.ts` had a local `flipOp`
  closure that duplicated `flipComparison` from `predicate-shape.ts`. The
  implement summary already claimed the shared helper was in use — it
  wasn't. Replaced with an import from `predicate-shape.ts`.
- **Misleading doc comment**: the new JSDoc on
  `predicate-shape.ts:flipComparison` cited `predicate-normalizer.ts` as
  exporting `invertComparison`. The actual export there is *also* named
  `flipComparison` (it negates the operator, e.g. `>` → `<=`). The real
  hazard is the same-name collision across the two files; comment rewritten
  to call that out explicitly.
- **`docs/optimizer.md` gaps**: four edits — added the `range` variant to
  the `GuardClause` type block, added four rows to the implication-form
  CHECK disjunct table, added five rows to the partial-UC conjunct table
  (including BETWEEN), and rewrote the
  "Predicates `predicateImpliesGuard` recognizes today" paragraph (which
  had explicitly said "inequality and arithmetic-shape guards remain out of
  scope" — now false). The rewrite also lists the still-out-of-scope items
  (eq-literal not piggybacking on range, NOCASE collation, parameter
  bounds, NOT BETWEEN) so the doc is now the canonical capability list.

**Examined and sound:**

- Negation table in `recognizeNegatedGuard` matches strict boolean negation
  of the disjunct: `<` ↔ `>=` (inclusive flips), `<=` ↔ `>` (exclusive
  flips), `>` ↔ `<=`, `>=` ↔ `<`. Inclusivity flags for the absent side
  default to `false`.
- `tightenLowerBound` / `tightenUpperBound` ties at equal values favor the
  exclusive flag (stronger). Setting only one side preserves the orthogonal
  side's flag, and the initial-write path explicitly initializes the
  opposite-side inclusivity to `false`.
- `filterRangeSubsetOfGuardRange` correctly returns `true` when a guard
  side is absent (trivially satisfied), and rejects the boundary case
  where filter is inclusive at the boundary value but guard is exclusive
  there. Verified by the `filter age >= 18` / `guard age > 18` test case.
- NULL handling: filter bound facts only accumulate from non-NULL
  literals; SQL three-valued semantics already exclude rows where the
  filtered column is NULL (`NULL >= 21` is NULL, not TRUE). Partial-UC
  predicates have the same property. Consistent.
- `compareSqlValues` is called with the 2-arg form — its default
  collation is `'BINARY'`, matching the summary and the
  `DomainConstraint`-range comparison style used elsewhere.
- Per-helper range coverage: `guardClauseEquals` compares column +
  per-side presence + value (via `sqlValueEquals`) + inclusivity;
  `projectClause` drops the FD when the column doesn't map; `shiftClause`
  shifts the column index; all three exercised in tests.
- Test coverage: happy path (subset/non-subset), inclusivity boundary,
  AND-intersection to a closed interval, EC-peer discharge, BETWEEN,
  NOT BETWEEN rejection, operand-flip, dedupe vs structural-difference
  preservation, projection drop + remap, shift, the explicit
  "eq-literal does not piggyback on range" guard. The two pre-existing
  tests that used `>` as an "unrecognized" probe were correctly
  re-pointed at `!=`.

**Major — none filed.** No new fix/plan/backlog tickets spawned.

**Out-of-scope gaps (already documented in source and re-stated in
`docs/optimizer.md`):** collation-aware text bound comparison (NOCASE),
parameter/symbolic bounds, NOT BETWEEN decomposition, eq-literal →
range cross-discharge, and empty-interval contradiction detection (owned
by the predicate-contradiction-detection ticket).
