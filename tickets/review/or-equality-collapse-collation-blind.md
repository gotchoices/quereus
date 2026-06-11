description: Review the collation gates added to both OR-of-equalities collapse sites (normalizer OR→IN rewrite of the evaluated predicate; constraint-extractor OR→IN/OR_RANGE pushdown constraints) — fixed wrong query results reproduced at HEAD.
files:
  - packages/quereus/src/planner/analysis/predicate-normalizer.ts          # tryCollapseOrToIn per-disjunct gate (evaluated predicate)
  - packages/quereus/src/planner/analysis/constraint-extractor.ts          # orBranchConstraintCollationOk + pre-gate in tryExtractOrBranches (pushdown)
  - packages/quereus/src/planner/analysis/comparison-collation.ts          # helpers reused, unchanged
  - packages/quereus/test/planner/collation-soundness.spec.ts              # SQL regression block (7 tests, t20–t26)
  - packages/quereus/test/planner/constraint-extractor.spec.ts             # unit block "OR collapse — collation gate" (7 tests) + textColRef/collatedLit helpers
  - docs/optimizer.md                                                      # new "OR-collapse gates" bullet in § Collation gate on equality facts
difficulty: medium
----

# Review: OR→IN / OR_RANGE collapse gated on matching effective collation

## What was built

Both collapse sites now require, per disjunct, that the effective comparison
collation (`effectiveComparisonCollation(left, right)` in **written** operand
order — right ?? left ?? BINARY, mirroring `emitComparisonOp`) **equals** the
collation the collapsed form compares under (the column operand's own
collation). Any mismatch declines the whole collapse; the OR stays residual —
a completeness loss only, exactly like the pre-existing >32-values bail.

- `predicate-normalizer.ts` `tryCollapseOrToIn`: gate inside the disjunct
  loop, right after the col/lit pattern match — compares against
  `effectiveInCollation(col)`. This fixes the *evaluated*-predicate rewrite
  (the wrong-results bug: `b = 'bob' collate nocase or b = 'x' collate nocase`
  was rewritten into an IN that compares under the bare column's collation).
- `constraint-extractor.ts` `orBranchConstraintCollationOk` + a single
  pre-gate loop in `tryExtractOrBranches` after the same-relation check,
  covering both Case 1 (`collapseBranchesToIn`) and Case 2
  (`tryCollapseToOrRange`). Per `sourceExpression` shape:
  - `BinaryOpNode`: eff vs `operandCollation(columnSideOf(src, attributeId))`
    (reuses the existing cast-unwrapping helper); fails when the column side
    can't be located.
  - `InNode`: vacuously true (condition is always a bare ColumnReference from
    `extractInConstraint`); kept explicit with a comment.
  - `BetweenNode`: both `effectiveBetweenBoundCollation(expr, lower/upper)`
    must equal `operandCollation(expr)`.
  - Anything else: conservative **fail** — deliberately the opposite polarity
    of `equalityConstraintCollationOk`'s permissive fallback (here permissive
    = wrong rows from a consuming seek).

Strict equality (not the covered-key "BINARY or declared" rule) is
load-bearing: the over-match direction (BINARY disjunct over a NOCASE column)
needs eff === declared.

## Validation performed

- `yarn test` (root): all workspaces green, 5867 passing in quereus.
- `yarn workspace @quereus/quereus run lint`, `yarn typecheck`
  (`tsc --noEmit`), and `yarn workspace @quereus/quereus run build`: clean.
- Negative verification: with only the two source files stashed back to HEAD,
  the new spec run bails at the first regression test — the tests genuinely
  pin the fix, both directions.

## Use cases to re-verify in review

All expected values were verified by the fix stage at HEAD and are now pinned
in `collation-soundness.spec.ts` (tables t20–t26):

- Keyed under-match: NOCASE disjuncts over BINARY-keyed `b` → y [1,2,3,4]
  (was [2,4] — exercises the extractor/seek path AND the normalizer).
- Non-keyed spelling → same [1,2,4,3 sorted] (proves the *evaluated* predicate
  path, no seek involved).
- Over-match: BINARY disjuncts over NOCASE-declared PK → [] (was [1,3]).
- Matched controls: plain/plain → [2,4]; plain disjuncts over NOCASE column →
  [1,3]; single NOCASE disjunct → both case-variants.
- OR_RANGE shape (`b='bob' collate nocase or b>'z'`, non-keyed) → [1,2,3]
  (passed at HEAD only via residual re-application; now declined at source).

Unit tests (`constraint-extractor.spec.ts`, "OR collapse — collation gate")
assert mismatched ORs produce **no** IN/OR_RANGE constraint plus a
residualPredicate (the "no seek strips the residual" guarantee at its source),
for eq→IN both directions, eq-as-range→OR_RANGE, and a BETWEEN branch with a
collated bound; matched NOCASE-declared IN and OR_RANGE collapses still fire;
and the written-order subtlety (`'bob' COLLATE NOCASE = b` over an explicitly
BINARY-typed column resolves right-precedence → BINARY → collapse allowed).

## Known gaps / honest notes for the reviewer

- `effectivePredicateCollation` (rule-select-access-path) still resolves an OR
  `sourceExpression` to BINARY. Post-gate every surviving collapsed
  constraint's true collation equals the column's declared collation, so the
  cover analysis is at worst conservative (BINARY-vs-NOCASE-index →
  COARSER_SAFE keeps the semantically-correct OR residual; ranges decline).
  Carrying the resolved collation on the constraint would make it precise —
  optional follow-up per the implement ticket, deliberately not done here.
- The gate is collation-**name** equality with no textuality reasoning:
  `x = 5 collate nocase or x = 6` over an integer column now declines collapse
  even though collation is inert for non-text. Accepted completeness loss per
  the ticket; do not widen without exported-helper support.
- The conservative `return false` fallback also hits IS-NULL-branch ORs
  (UnaryOp source). Verified no behavior change: neither Case 1 (requires
  `=`/`IN` ops) nor Case 2 (requires range ops) could collapse those shapes
  before. Same for nested-IN-inside-AND branches (OR sourceExpression) — the
  column-side lookup fails, but those branches could never collapse either
  (multi-constraint branches with an IN op fail both cases).
- Mild asymmetry, per the implement ticket's spec: the BinaryOp arm reads the
  cast-unwrapped column side's collation (`columnSideOf`), the Between arm
  reads `src.expr`'s type directly (possibly a Cast). Planner-inserted casts
  do not currently carry collations, so the two agree in practice.
- The BETWEEN-with-collated-bound shape previously collapsed to OR_RANGE (a
  real latent bug caught only by the new unit test) — no SQL-level repro was
  specified in the implement ticket, so coverage there is unit-level only.
- Drive-by: `tryCollapseOrToIn`'s unused `scope` param renamed `_scope`
  (project convention; it builds the InNode from `column.scope`).
- `yarn test:store` not run (memory-backed default per AGENTS.md; nothing
  store-specific in the diff).
