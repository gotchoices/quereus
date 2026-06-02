description: Review the coverage-extension tests pinning the lens parent-side FK divergent-basis-action mechanism — composite (multi-column) divergent FKs, the divergent (basis × logical) action matrix, the multi-equivalent-basis-FK residual, transitive/multi-level divergence, and store-backend validation. Test-only change; no production code touched.
files: packages/quereus/test/lens-enforcement.spec.ts, packages/quereus/src/schema/lens-fk-discovery.ts, packages/quereus/src/runtime/foreign-key-actions.ts, docs/lens.md
----

# Lens parent-side FK divergent basis action — coverage extensions (review)

## What landed

Thirteen new tests appended to the existing `describe('lens enforcement: parent-side
FK divergent basis action', …)` block in `packages/quereus/test/lens-enforcement.spec.ts`
(immediately after the prior two unit tests, before the block close). **No production
code changed** — the mechanism behaved as documented across every previously-unpinned
case, confirming the shipping ticket's "uniform by argument" claim.

The divergent mechanism under test lives in:
- `schema/lens-fk-discovery.ts`: `basisFksOverriddenByDivergentLensFk` /
  `matchingBasisFksForLensRef` / `matchingBasisFksCore` (column-set / unordered-pair-set
  match; non-RESTRICT logical action overrides a divergent basis action).
- `runtime/foreign-key-actions.ts`: the four suppression sites — `executeForeignKeyActions`
  (basis action), `assertNoRestrictedChildrenForParentMutation` (basis RESTRICT pre-check),
  `assertTransitiveRestrictsForParentMutation` step-2 (transitive recursion skip), and the
  lens cascade walker's agree/diverge elision in `executeLensFkActionsForParentSlot`.

## New cases (all passing)

- **Composite (2-column) divergent FK** `(a, b) → parent(px, py)`:
  - DELETE: logical SET NULL over basis CASCADE ⇒ both FK columns nulled, rows survive.
  - UPDATE: logical CASCADE over basis SET NULL ⇒ both FK columns re-keyed (`a` 1→9, `b` 2 unchanged).
  - **Permuted negative** (unit): basis FK pairs `(a→py, b→px)` vs logical `(a→px, b→py)`
    ⇒ `matchingBasisFksForLensRef` returns `[]` and `basisFksOverriddenByDivergentLensFk`
    is empty for both ops (order-independent pair-set must NOT match a permutation).

- **Divergent action matrix** (single-column), the pairs not previously exercised:
  - DELETE & UPDATE: logical CASCADE over basis SET NULL.
  - DELETE & UPDATE: logical SET DEFAULT over basis SET NULL (`pid integer default 0`, parent 0 seeded).
  - DELETE & UPDATE: logical SET NULL over basis SET DEFAULT.
  (Existing suite already covered SET NULL/CASCADE, CASCADE/RESTRICT, SET DEFAULT/CASCADE.)

- **Multi-equivalent-basis-FK residual** (unit): two basis FKs over the identical column
  with mixed actions (CASCADE + SET NULL), logical CASCADE. Pins that only the *divergent*
  SET NULL basis FK is in the overridden set; the *agreeing* CASCADE basis FK is NOT
  suppressed (documented sound-but-non-minimal — it co-runs, never a dropped action).
  NOTE: this confirms two FKs on the same column to the same parent parse + register.

- **Transitive / multi-level divergence** (parent → child → grandchild):
  - *Step-2 suppression*: parent→child diverges (basis CASCADE, logical SET NULL),
    child→grandchild is a logical RESTRICT. The suppressed basis cascade must NOT be
    followed in the pre-walk ⇒ the delete SUCCEEDS (child nulled, grandchild survives,
    no spurious RESTRICT abort). This is the precise validation that the step-2 skip in
    `assertTransitiveRestrictsForParentMutation` works — without it, the pre-walk would
    recurse the basis cascade and trip the grandchild RESTRICT.
  - *Re-entry transitivity*: parent→child diverges (basis SET NULL, logical CASCADE),
    child→grandchild RESTRICT ⇒ the logical cascade's child-view DELETE re-enters the lens
    write path, re-fires the transitive walk at the child level, and the grandchild RESTRICT
    ABORTs. Atomic rollback verified; clearing the grandchild then lets the delete cascade.

## Validation performed

- `lens-enforcement.spec.ts` full file: **125 passing** (memory-backed vtab).
- Divergent/transitive grep against the **store backend** (`QUEREUS_TEST_STORE=true`,
  rowid-mode / lamina): **24 passing** — the item the shipping ticket flagged as
  not-agent-runnable. The suppressed-basis-cascade interaction with rowid-chained
  post-mutation scans surfaced **no** backend-specific gap, so no `fix/` ticket was filed.
- `eslint test/lens-enforcement.spec.ts`: clean.

## Reviewer notes / known floors

- All assertions verify end-state via logical-view `select`s; the divergent matrix tests
  do not separately assert the *basis* row state for every combo (only the headline
  SET NULL/CASCADE delete does, mirroring the existing suite). A reviewer wanting tighter
  pins could add `y.child` assertions per matrix row — low value, the lens re-plan to basis
  is already covered.
- The store run was scoped to the divergent/transitive grep, not the full `lens-enforcement`
  spec under store, to stay within the agent wall-clock budget. A full `yarn test:store`
  pass remains a CI/human out-of-band check (unchanged from the shipping ticket's deferral).
- The multi-match residual test asserts only the `overridden` set membership (the cheap,
  deterministic pin), not the double-application end state (idempotent ⇒ not observable).
