description: REVIEW — a lens-backed logical parent-side FK's **non-RESTRICT** action (cascade / set null / set default) now wins over a structurally-equivalent **divergent** basis FK action over the same columns. The lens cascade walker's elision is action-aware (elide only when the basis action AGREES), and the basis FK's physical action / RESTRICT check is suppressed at every enforcement site when a divergent non-RESTRICT logical FK overrides it.
prereq: lens-parent-side-fk-cascade-basis-restrict-lens-runtime-precheck
files: packages/quereus/src/schema/lens-fk-discovery.ts, packages/quereus/src/runtime/foreign-key-actions.ts, packages/quereus/src/planner/building/foreign-key-builder.ts, packages/quereus/test/lens-enforcement.spec.ts, docs/lens.md
----

# Lens parent-side FK divergent basis action — the logical action wins (review)

## What landed

Closes the **logical-action-is-non-RESTRICT** half of the divergent (basis action × logical
action) matrix: when a lens-backed logical parent and its basis child both carry a parent-side
FK over the **same structurally-equivalent columns** (unordered mapped `(basisChildCol →
basisParentCol)` index-pair set) but with **divergent referential actions**, the **logical
FK's action is now authoritative**. The basis action over those equivalent columns is
suppressed; the logical action runs (exactly once).

The complementary **logical-action-is-RESTRICT** half is the prereq
(`lens-parent-side-fk-cascade-basis-restrict-lens-runtime-precheck`, still in `implement/`).
The two are exact complements by predicate: this ticket's `basisFksOverriddenByDivergentLensFk`
ignores logical-RESTRICT refs (non-RESTRICT only), and the prereq's
`assertLensRestrictsForParentMutation` fires only for logical RESTRICT — they never overlap.
**Note for the reviewer:** the prereq has *not* landed yet. This implementation is
self-contained and does not call `assertLensRestrictsForParentMutation`, but `docs/lens.md`
now references it as the complementary direction (forward-looking, per the "design as if the
prereq lands" rule). If the prereq is dropped, that one doc reference would dangle.

## The two coordinated halves (exact complements)

**(A) Action-aware lens-walker elision** (`runtime/foreign-key-actions.ts`,
`executeLensFkActionsForParentSlot`): the old action-agnostic `basisChildCarriesEquivalentFk`
boolean elide was replaced with `matches = matchingBasisFksForLensRef(...)` +
`agree = matches.length > 0 && matches.every(action agrees)`. Elide iff `agree`; otherwise fire
the logical action (no match ⇒ basis enforces nothing ⇒ fire; divergent match ⇒ logical wins).

**(B) Basis suppression** via `basisFksOverriddenByDivergentLensFk(basisParent, op, sm)` — the
set of basis FKs overridden by a divergent non-RESTRICT logical FK — computed once and consulted
(`suppressed.has(fk)`, identity lookup) at **four** sites:
- `executeForeignKeyActions` — skip the suppressed physical cascade/null/default.
- `assertNoRestrictedChildrenForParentMutation` — skip the suppressed basis RESTRICT pre-check.
- `assertTransitiveRestrictsForParentMutation` step 2 — skip the suppressed cascading basis FK in
  the recursion (its physical cascade won't run; the logical action's transitivity is enforced
  when its child-view DML re-enters the walk).
- `buildParentSideFKChecks` (`planner/building/foreign-key-builder.ts`) — skip the suppressed
  basis RESTRICT's immediate plan-time `NOT EXISTS`.

**Shared discovery** (`schema/lens-fk-discovery.ts`): added `matchingBasisFksForLensRef` and
`basisFksOverriddenByDivergentLensFk`; refactored `basisChildCarriesEquivalentFk` onto a shared
`matchingBasisFksCore` (one match path). `basisChildCarriesEquivalentFk` is **still exported,
still action-agnostic** for the existing direct-call unit tests, but is no longer the walker's gate.

**Complement invariant (the load-bearing argument — documented inline on
`basisFksOverriddenByDivergentLensFk`):** for one equivalent basis FK `m`, logical op-action `L`
(non-RESTRICT), basis op-action `B`: `L === B` ⇒ walker elides AND `m ∉ overridden` (basis acts,
one action); `L !== B` ⇒ walker fires AND `m ∈ overridden` (basis suppressed, one action). So the
children are mutated by *exactly one* path — never both (no double-mutation), never neither (no
dropped enforcement).

## Validation done (all green on the memory backend)

- `yarn workspace @quereus/quereus run build` — clean (`tsc`, exit 0).
- `yarn workspace @quereus/quereus run lint` — clean (exit 0).
- `yarn test` (memory backend) — **4365 passing, 9 pending**, exit 0. No new failures, no
  regressions in the existing `lens enforcement` suites.

## Tests added (`test/lens-enforcement.spec.ts`, `describe('… divergent basis action')`)

Deploys a basis-with-FK + logical-with-divergent-FK shape via a focused `deployDivergentFkLens`
helper (basis tail action `B`, logical tail action `L ≠ B` over the same `pid → parent(id)`):

- DELETE, logical `set null` over basis `cascade` ⇒ children **nulled, not deleted** (logical +
  basis rows both `pid is null`, count unchanged).
- DELETE, logical `cascade` over basis `restrict` ⇒ delete **succeeds** (not aborted by the basis
  RESTRICT immediate/pre-check) ⇒ children **cascade-deleted** (the headline case).
- DELETE, logical `set default` over basis `cascade` (child `default 0`) ⇒ children survive with
  FK = 0.
- UPDATE of the referenced key, logical `set null` over basis `cascade` ⇒ children **nulled, not
  re-keyed**; benign non-key UPDATE short-circuits (child untouched).
- Agreeing-action control (logical `cascade` over basis `cascade`) ⇒ single cascade, no
  double-mutation (regression pin for the agree path).
- No-equivalent-basis-FK control (basis FK-free cascade lens) ⇒ logical action still fires
  (regression pin for the refactor).
- Two direct-call unit tests: `matchingBasisFksForLensRef` returns the equivalent basis FK and
  `basisFksOverriddenByDivergentLensFk` contains it (by identity) iff divergent non-RESTRICT;
  empty when actions agree or the logical action is RESTRICT.

## Known gaps / where the tests are a floor (please scrutinize)

These are **honest gaps**, not blockers — the mechanism is uniform across them, but they are not
pinned by a test:

1. **Composite (multi-column) divergent FK is not tested.** Only single-column `pid → id` cases
   are exercised. `mappedFkBasisPairs` / the walker already handle composite keys (the
   non-divergent composite cascade/restrict suites pass), and suppression is column-set-based, so
   composite divergence *should* work — but a composite divergent test would close this directly.
2. **The matrix is covered representatively, not exhaustively.** Tested pairs: setNull/cascade
   (delete+update), cascade/restrict (delete), setDefault/cascade (delete). Other divergent
   non-RESTRICT pairs (e.g. logical `cascade` over basis `set null`, logical `set default` over
   basis `set null`) ride the identical code path but are not individually pinned.
3. **Transitive / multi-level divergence is reasoned, not tested.** The step-2 suppression in
   `assertTransitiveRestrictsForParentMutation` is covered by argument (the logical action's
   child-view DML re-enters the walk), but there is no parent→child→grandchild divergent test.
   The existing transitive cascade test (non-divergent) still passes.
4. **Pathological multi-equivalent-basis-FK residual is documented but untested.** Two basis FKs
   over identical columns with mixed actions would let an *agreeing* same-action basis FK also run
   (a double application of the *same* idempotent-ish action — never a dropped enforcement). This
   matches the existing "any uncertainty double-acts" bias; it is hard to construct and not
   exercised.
5. **Store backend (rowid-mode / lamina) not validated.** `yarn test:store` is not agent-runnable
   inside the ticket (mirrors the prereq's out-of-scope note). If a store-specific (rowid-chained)
   gap surfaces — e.g. the suppressed-basis-cascade interaction with rowid post-mutation scans —
   file a `tickets/backlog/` ticket rather than expanding scope here.

## Drift / soundness profile (matches existing code)

- `buildParentSideFKChecks` suppression reads the **current** basis FK set at plan time — exactly
  the soundness/drift profile of the existing `lensParentSideForeignKeyRedundant` elision and the
  physical builder it mirrors.
- Every suppression site is already inside a `foreign_keys` gate; `basisFksOverriddenByDivergentLensFk`
  is a cheap early-empty when no lens slot is backed by the parent (the common non-lens DML pays
  one empty-set construction).

## Not changed (deliberately)

- `collectLensParentSideForeignKeyConstraints` / `lensParentSideForeignKeyRedundant` (the lens
  RESTRICT collector + its elision) — only the **walker** + the four basis sites changed.
- `assertLensRestrictsForParentMutation` (prereq's lens-RESTRICT pre-check) — orthogonal (logical
  RESTRICT only); this ticket's predicate is non-RESTRICT-logical only.
- `basisChildCarriesEquivalentFk` keeps its action-agnostic meaning + export.
