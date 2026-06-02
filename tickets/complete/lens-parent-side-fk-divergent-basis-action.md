description: COMPLETE — a lens-backed logical parent-side FK's non-RESTRICT action (cascade / set null / set default) now wins over a structurally-equivalent divergent basis FK action over the same columns. The lens cascade walker's elision is action-aware (elide only when the basis action AGREES); the basis FK's physical action / RESTRICT check is suppressed at every enforcement site (`basisFksOverriddenByDivergentLensFk`) when a divergent non-RESTRICT logical FK overrides it. Reviewed and validated.
files: packages/quereus/src/schema/lens-fk-discovery.ts, packages/quereus/src/runtime/foreign-key-actions.ts, packages/quereus/src/planner/building/foreign-key-builder.ts, packages/quereus/test/lens-enforcement.spec.ts, docs/lens.md
----

# Lens parent-side FK divergent basis action — the logical action wins (complete)

## What landed

When a lens-backed logical parent and its basis child both carry a parent-side FK over the
**same structurally-equivalent columns** (unordered mapped `(basisChildCol → basisParentCol)`
index-pair set) but with **divergent referential actions**, and the **logical** action is
**non-RESTRICT** (cascade / set null / set default), the logical action is now authoritative:
the basis action over those equivalent columns is suppressed and the logical action runs
exactly once.

Two coordinated halves (exact complements by the single-equivalent-basis-FK invariant):

**(A) Action-aware lens-walker elision** (`runtime/foreign-key-actions.ts`,
`executeLensFkActionsForParentSlot`): `matches = matchingBasisFksForLensRef(...)`; elide iff
`matches.length > 0 && every match's op-action AGREES` with the logical action. No match ⇒
basis enforces nothing ⇒ fire; divergent match ⇒ logical wins ⇒ fire.

**(B) Basis suppression** via `basisFksOverriddenByDivergentLensFk(basisParent, op, sm)` —
computed once and consulted (identity `suppressed.has(fk)`) at four sites:
- `executeForeignKeyActions` (skip the suppressed physical cascade/null/default),
- `assertNoRestrictedChildrenForParentMutation` (skip the suppressed basis RESTRICT pre-check),
- `assertTransitiveRestrictsForParentMutation` step 2 (skip the suppressed cascading basis FK
  in the recursion — its transitivity rides the logical action's own child-view DML re-entry),
- `buildParentSideFKChecks` (skip the suppressed basis RESTRICT's plan-time `NOT EXISTS`).

Shared discovery (`schema/lens-fk-discovery.ts`): `matchingBasisFksForLensRef` and
`basisFksOverriddenByDivergentLensFk` added; `basisChildCarriesEquivalentFk` refactored onto a
shared `matchingBasisFksCore` and kept exported (action-agnostic) for existing direct-call unit
tests, but is no longer the walker's gate.

The complementary **logical-action-is-RESTRICT** direction landed via the prereq
(`lens-parent-side-fk-cascade-basis-restrict-lens-runtime-precheck`, now at HEAD —
`assertLensRestrictsForParentMutation`). Together the two cover **every** divergent
(basis action × logical action) pair: the logical action always wins. The two predicates are
disjoint by construction (this ticket's set ignores logical-RESTRICT refs; the prereq fires only
for logical RESTRICT).

## Review findings

**Scope reviewed:** the implement diff (commit `29d76666`) read first with fresh eyes, then the
handoff. Scrutinized SPP/DRY/modularity, type safety, resource cleanup, error handling, the
complement invariant, FK-object identity for the suppression lookups, predicate disjointness with
the now-landed prereq, transitive/multi-level reasoning, docs currency, and the test floor.

**Correctness — clean.** No bugs found in the core logic. Verified:
- The walker-elision (A) and basis-suppression (B) halves are exact complements for one
  equivalent basis FK: `L === B` ⇒ elide ∧ not-suppressed (basis acts once); `L !== B` ⇒ fire ∧
  suppressed (logical acts once). Children are mutated by exactly one path — never both, never
  neither.
- `matchingBasisFks` returns the *same* `ForeignKeyConstraintSchema` object references the
  enforcement sites iterate over (`childTable.foreignKeys`), so the identity-keyed
  `Set<ForeignKeyConstraintSchema>.has(fk)` lookups at all four sites are sound.
- The non-RESTRICT-logical predicate of `basisFksOverriddenByDivergentLensFk` never overlaps the
  prereq's logical-RESTRICT `assertLensRestrictsForParentMutation` — the two halves of the
  divergent matrix are disjoint.
- The step-2 transitive suppression is sound: the suppressed basis cascade's physical walk never
  runs, and the logical action's child-view DML re-enters the DML executor (re-firing the
  transitive RESTRICT walk + lens scan) at the next level, so a grandchild RESTRICT is still
  enforced (at execution time, within the same atomic transaction).
- `basisChildCarriesEquivalentFk` is genuinely still referenced by existing unit tests
  (`lens-enforcement.spec.ts`), not dead code.

**Docs — current.** `docs/lens.md` updated to state the logical action wins for the divergent
case and references `basisFksOverriddenByDivergentLensFk` + the prereq's
`assertLensRestrictsForParentMutation`. The forward reference to the prereq no longer dangles —
the prereq landed at HEAD (`90f63a17` / `ebfb7f7a`) before this review. Verified the "every
divergent pair" claim holds across both tickets.

**Tests — pass, with documented floors.** Build clean (`tsc`, exit 0), lint clean (exit 0), full
memory-backend suite **4376 passing, 9 pending, exit 0**, no regressions. The added suite
(`describe('… divergent basis action')`) covers delete + update, setNull/cascade, cascade/restrict
(headline), setDefault/cascade, the agreeing-action control, the no-equivalent-basis-FK control,
and two direct-call unit assertions. The implementer's documented gaps (composite divergent FK,
exhaustive matrix, transitive divergence, multi-equivalent residual, store backend) are honest
floors that ride identical code paths and are sound by argument — filed forward as a backlog
coverage ticket (`lens-parent-side-fk-divergent-coverage-extensions`) rather than blocking.

**Minor — stray test (no action, documented).** This commit also added
`packages/quereus/test/logic/43.2-deferred-check-new-on-delete.sqllogic`, a regression guard for
"No row context found for column" on a deferred CHECK over DELETE. That behavior is fixed by
`emit/delete.ts` / `building/delete.ts`, which landed in the *prior* ticket
(`view-mutation-multisource-delete-returning-computed-column`, commit `4ee009d6`) — not in this
diff. The test is valid, passes, and is the only dedicated sqllogic guard for that fix, so it was
**kept** (removing it would lose real coverage); the misattribution is recorded here.

**Performance — acceptable, noted.** `basisFksOverriddenByDivergentLensFk` is recomputed at each
of the four sites and once per transitive-recursion level / per parent-row mutation, each a full
`schemas × lens-slots × findLogicalParentFkRefs × matchingBasisFks` scan. Bounded by *schema*
size (not data) and cheap-empty for non-lens DBs (no lens slots ⇒ inner loop body never runs);
consistent with the file's existing per-call re-scan patterns. Not a blocker; memoization is a
future option if profiling shows it.

**Disposition:** no major findings, no inline fixes required. One backlog ticket filed for the
documented coverage floors. No `.pre-existing-error.md` written — no pre-existing failures
surfaced.

## Not changed (deliberately, confirmed)

- `collectLensParentSideForeignKeyConstraints` / `lensParentSideForeignKeyRedundant` (the lens
  RESTRICT collector + its elision) — only the walker + the four basis sites changed.
- `assertLensRestrictsForParentMutation` (prereq's lens-RESTRICT pre-check) — orthogonal.
- `basisChildCarriesEquivalentFk` keeps its action-agnostic meaning + export.
