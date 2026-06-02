description: Coverage-extension tests pinning the lens parent-side FK divergent-basis-action mechanism — composite (multi-column) divergent FKs, the divergent (basis × logical) action matrix, the multi-equivalent-basis-FK residual, and transitive/multi-level divergence. Test-only; no production code changed. Reviewed and archived.
files: packages/quereus/test/lens-enforcement.spec.ts, packages/quereus/src/schema/lens-fk-discovery.ts, packages/quereus/src/runtime/foreign-key-actions.ts, docs/lens.md
----

# Lens parent-side FK divergent basis action — coverage extensions (complete)

## What landed

Twelve new tests appended to `describe('lens enforcement: parent-side FK divergent
basis action', …)` in `packages/quereus/test/lens-enforcement.spec.ts`. **No production
code changed** — the mechanism behaved as documented across every previously-unpinned
case, confirming the shipping ticket's "uniform by argument" claim.

The divergent mechanism under test:
- `schema/lens-fk-discovery.ts`: `matchingBasisFks` (order-independent
  `(childCol → parentCol)` index pair-set match) / `matchingBasisFksForLensRef` /
  `basisFksOverriddenByDivergentLensFk` (a divergent non-RESTRICT logical action
  overrides the matching basis FK).
- `runtime/foreign-key-actions.ts`: the suppression sites — the basis action in
  `executeForeignKeyActions`, the basis RESTRICT pre-check in
  `assertNoRestrictedChildrenForParentMutation`, the step-2 recursion skip in
  `assertTransitiveRestrictsForParentMutation` (`foreign-key-actions.ts:202`), and the
  lens cascade walker's agree/diverge elision.

## New cases

- **Composite (2-column) divergent FK** `(a, b) → parent(px, py)`: DELETE (logical SET NULL
  over basis CASCADE ⇒ both columns nulled, rows survive) and UPDATE (logical CASCADE over
  basis SET NULL ⇒ both columns re-keyed: `a` 1→9, `b` 2 unchanged); plus a **permuted
  negative** unit (basis `(a→py, b→px)` vs logical `(a→px, b→py)` ⇒ pair-sets differ ⇒ no
  match, nothing suppressed).
- **Divergent action matrix** (single-column), the pairs not previously exercised:
  CASCADE/SET NULL, SET DEFAULT/SET NULL, SET NULL/SET DEFAULT — each for DELETE and UPDATE.
- **Multi-equivalent-basis-FK residual** (unit): two basis FKs over the identical column
  (CASCADE + SET NULL), logical CASCADE ⇒ only the divergent SET NULL basis FK is in the
  overridden set; the agreeing CASCADE basis FK is not (documented sound-but-non-minimal).
- **Transitive / multi-level divergence**: step-2 suppression (a suppressed basis cascade
  is not recursed in the pre-walk ⇒ no spurious grandchild-RESTRICT abort) and re-entry
  transitivity (the logical cascade's child-view DELETE re-enters the lens write path and
  re-fires the grandchild RESTRICT ⇒ atomic abort; clearing the grandchild then cascades).

## Review findings

**Scope checked:** the implement-stage diff (commit `4e17917d`), the two production modules
the tests reach into (`lens-fk-discovery.ts`, `foreign-key-actions.ts`), the test helpers
(`deployDivergentFkLens`, `slot`, `rows`, `expectThrows`), and `docs/lens.md`.

- **Production paths the tests target are real (verified, not assumed).** The
  order-independent pair-set match (`matchingBasisFks`, `lens-fk-discovery.ts:126`), the
  divergent-only override (`basisFksOverriddenByDivergentLensFk:339`), the step-2 recursion
  skip (`foreign-key-actions.ts:202`), and the step-1b lens RESTRICT pre-check
  (`foreign-key-actions.ts:172`) are each exercised by the matching test. The transitive
  step-2 test is a genuine regression pin: without the `suppressed.has(fk)` skip the basis
  cascade would recurse to the child level where step-1b would find the grandchild RESTRICT
  and abort.
- **The permuted-negative unit is non-vacuous.** Its `matchingBasisFksForLensRef.length === 0`
  could in principle be a false pass (mapping failure rather than the permutation). It is not:
  the positive composite runtime tests prove composite mapping + matching + suppression work
  end-to-end (children null/re-key as the divergent action dictates), so the negative's 0 is
  attributable to the differing pair-set. Cross-checked by hand: logical pairs `{(a,px),(b,py)}`
  vs basis `{(a,py),(b,px)}`.
- **Test hygiene:** every test wraps `db.close()` in `finally`; the multi-match unit selects
  basis FKs by action (`.find(f => f.onDelete === …)`) not declaration order; `expectThrows`
  guards against a no-throw false pass (asserts `threw`). No issues.
- **Docs:** `docs/lens.md` § Constraint Attachment already documents the divergent mechanism,
  `basisFksOverriddenByDivergentLensFk`, the step-2 suppression, the lens-RESTRICT pre-check,
  and the multi-match residual, and asserts "the logical action wins for every divergent
  (basis × logical) pair." Accurate against the code as tested — **no doc update needed**.

**Validation re-run during review:**
- `lens-enforcement.spec.ts`, memory backend: **125 passing**.
- Same spec under the **store backend** (`QUEREUS_TEST_STORE=true`): **125 passing** (~2s).
- `eslint test/lens-enforcement.spec.ts`: **clean**.

**Minor (no code change — handoff/doc inaccuracies only, source ticket archived):**
- The implement handoff said "Thirteen new tests"; the diff adds **12** `it()` blocks.
- The handoff deferred a full store-backend run of the spec as "not agent-runnable / CI
  out-of-band." It **is** agent-runnable: the full `lens-enforcement.spec.ts` runs under the
  store backend in ~2s and passes (125). Recorded here so the deferral is not carried forward.

**Considered and declined:** strengthening the permuted-negative unit with an explicit
"basis FK registered" assertion — marginal value, already covered by the positive composite
cross-check. Adding per-matrix-row basis (`y.child`) assertions — low value, the lens→basis
re-plan is covered by the headline SET NULL/CASCADE case (carried over from the shipping suite).

**Major:** none. No new fix/plan/backlog tickets filed.

## End
