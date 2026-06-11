description: OR→IN / OR_RANGE collapse gated on matching effective collation at both collapse sites (predicate-normalizer evaluated-predicate rewrite + constraint-extractor pushdown). Fixed wrong query results reproduced at HEAD. Reviewed and completed.
files:
  - packages/quereus/src/planner/analysis/predicate-normalizer.ts          # tryCollapseOrToIn per-disjunct gate (evaluated predicate)
  - packages/quereus/src/planner/analysis/constraint-extractor.ts          # orBranchConstraintCollationOk + pre-gate in tryExtractOrBranches (pushdown)
  - packages/quereus/src/planner/analysis/comparison-collation.ts          # helpers reused, unchanged
  - packages/quereus/test/planner/collation-soundness.spec.ts              # SQL regression block (7 tests, t20–t26)
  - packages/quereus/test/planner/constraint-extractor.spec.ts             # unit block "OR collapse — collation gate" (7 tests) + textColRef/collatedLit helpers
  - docs/optimizer.md                                                      # OR-collapse gates bullet (§ Collation gate) + 2 cross-ref edits added in review
----

# OR→IN / OR_RANGE collapse gated on matching effective collation

## What was built

Both OR-of-equalities collapse sites now require, per disjunct, that the
effective comparison collation (`effectiveComparisonCollation`, in **written**
operand order — right ?? left ?? BINARY, mirroring `emitComparisonOp`)
**equals** the collation the collapsed form compares under (the column
operand's own collation). Any mismatch declines the whole collapse and the OR
stays residual — a completeness loss only, like the pre-existing >32-values
bail.

- `predicate-normalizer.ts` `tryCollapseOrToIn`: per-disjunct gate against
  `effectiveInCollation(col)`. Fixes the *evaluated*-predicate wrong-results
  bug (`b = 'bob' collate nocase or …` rewritten into an IN that compared
  under the bare column's collation).
- `constraint-extractor.ts` `orBranchConstraintCollationOk` + a pre-gate loop
  in `tryExtractOrBranches` (after the same-relation check, before both Case 1
  `collapseBranchesToIn` and Case 2 `tryCollapseToOrRange`). Handles
  `BinaryOpNode` (eff vs `operandCollation(columnSideOf(...))`), `InNode`
  (vacuously true — condition is always a bare ColumnReference), `BetweenNode`
  (both bounds vs `operandCollation(expr)`), and a conservative **fail** for
  any other shape.

Strict equality (not the covered-key "BINARY or declared" rule) is
load-bearing: the over-match direction (BINARY disjunct over a NOCASE column)
needs eff === declared.

## Review findings

Adversarial pass over commit `f0d301ba`. Read the full source + test diff with
fresh eyes before the handoff, traced both collapse sites and the runtime
emit-mirror helpers, then ran lint / typecheck / full test suite.

### Correctness / soundness — checked, no findings
- **Both directions sound.** Re-derived the gate against `emitComparisonOp` /
  `emitIn` / `emitBetween` for under-match (NOCASE disjunct / BINARY column),
  over-match (BINARY disjunct / NOCASE column), and the written-order subtlety
  (`'bob' COLLATE NOCASE = b` → right precedence → column collation). All
  resolve as the comments claim. Strict equality is required and correct.
- **Column-vs-column branches** (`b = c OR b = d`, dynamic value side):
  `columnSideOf` correctly locates the constrained column; eff vs that
  column's collation matches the IN's runtime semantics. Handled, not just the
  literal case.
- **Pre-gate placement** is after `allRelations.size !== 1` and before both
  collapse cases — gates every shape that could collapse, declines conservatively
  for shapes that couldn't (IS-NULL / nested-IN-in-AND branches), which is a
  no-op since those never collapsed.
- **No missed collapse sites.** Searched for every OR→IN / OR-of-equalities
  rewrite. The only other IN/range fact paths (`fd-utils.ts` `buildPredicateFacts`
  IN-list + BETWEEN capture) are already independently collation-gated by the
  prior `collation-blind-equality-fact-extraction` ticket via
  `equalityCollationOk` / `rangeCollationOk`; OR-of-equalities there is handled
  by guard *discharge* (`inListEntailed`), not a collapse, so it needs no gate.
- **InNode value collations are inert** (`emitIn` compares under the condition
  operand only) — the vacuously-true arm is correct, and merged INs from mixed
  eq+IN branches stay sound.

### Tests — starting point extended/verified
- Ran the two touched specs in isolation (271 passing) and the full quereus
  suite (5867 passing, 9 pending). Happy path, both unsound directions, matched
  controls, OR_RANGE, and BETWEEN-with-collated-bound are all pinned.
- The implementer's negative-verification claim (stash sources → first
  regression test fails) is consistent with the test design; the unit block
  asserts *no* constraint + a residualPredicate, pinning the "no seek strips
  the residual" guarantee at its source.
- **Minor coverage note (no action):** the *predicate-normalizer* matched-case
  collapse is asserted to still *fire* only end-to-end (SQL t23), not at the
  unit level — unlike the extractor path, which has a direct
  `IN still fires` unit assertion. The normalizer rewrite is a pure
  optimization whose firing carries no seek-correctness weight, so a dedicated
  unit test was judged not worth a follow-up ticket.

### Docs — minor finding, fixed inline
- The detailed `OR-collapse gates` bullet (§ Collation gate on equality facts)
  was accurate. But two higher-level summaries described the collapse as
  unconditional: `Predicate Pushdown Implementation › Normalization` ("collapses
  small OR-of-equalities to IN") and the `OR predicate extraction` bullet. Added
  a brief cross-reference to the gate in both so a reader of the summaries isn't
  misled. No other doc touched by the change was stale.

### Accepted limitations (carried from implement, re-confirmed)
- **Non-textual over-decline:** `x = 5 collate nocase or x = 6` over an integer
  column now declines collapse even though collation is inert for non-text.
  Completeness loss only; widening needs exported textuality-aware helper
  support. Documented, not a regression.
- **`effectivePredicateCollation` still resolves an OR `sourceExpression` to
  BINARY** in rule-select-access-path. Post-gate the constraint's true collation
  equals the column's declared collation, so the cover analysis is at worst
  conservative (BINARY-vs-NOCASE-index → COARSER_SAFE keeps the correct OR
  residual; ranges decline). Carrying the resolved collation would make it
  precise — optional follow-up, not required for correctness, deliberately not
  done.
- **BinaryOp/Between arm asymmetry:** the BinaryOp arm reads the cast-unwrapped
  column side (`columnSideOf`); the Between arm reads `src.expr`'s type directly
  (possibly a Cast). Planner-inserted casts don't currently carry collations, so
  the two agree in practice. Re-confirmed: no current shape exercises a
  divergence.
- **BETWEEN-with-collated-bound** (a real latent over-collapse the new gate now
  declines) has unit-level coverage only — no SQL repro was specified in the
  implement ticket.

**Disposition:** no major findings → no new ticket spawned. One minor docs
finding fixed inline (this pass). Validation re-run clean.

## Validation performed (review pass)

- `node --import register.mjs mocha test/planner/collation-soundness.spec.ts
  test/planner/constraint-extractor.spec.ts` → 271 passing, 0 failing.
- `yarn workspace @quereus/quereus run lint` → exit 0.
- `yarn workspace @quereus/quereus run typecheck` (`tsc --noEmit`) → exit 0.
- `yarn workspace @quereus/quereus run test` (full memory-backed suite) → 5867
  passing, 9 pending, exit 0.
- `yarn test:store` not run — memory-backed default per AGENTS.md; nothing
  store-specific in the diff (the store range-seek collation path is covered by
  its own completed ticket and unchanged here).
