description: Extend test coverage for the lens parent-side FK divergent-basis-action mechanism — composite (multi-column) divergent FKs, the full divergent (basis action × logical action) matrix, transitive/multi-level divergence (parent→child→grandchild), and store-backend (rowid-mode / lamina) validation. These are untested floors of `lens-parent-side-fk-divergent-basis-action`, which shipped and was reviewed with the mechanism proven uniform across them by argument — not bugs, just unpinned coverage.
prereq: lens-parent-side-fk-divergent-basis-action
files: packages/quereus/test/lens-enforcement.spec.ts, packages/quereus/src/schema/lens-fk-discovery.ts, packages/quereus/src/runtime/foreign-key-actions.ts
effort: medium
----

# Lens parent-side FK divergent basis action — coverage extensions

The divergent-action resolution (a lens logical parent-side FK's non-RESTRICT action wins over a
structurally-equivalent divergent basis FK action; the complementary logical-RESTRICT direction
via the prereq) shipped and passed review. The implementation is uniform across the cases below —
suppression is column-set-based, the walker/suppression complement holds for any arity, and
composite cascade/restrict already pass in the non-divergent suites — so these are **coverage
floors, not suspected defects**. This ticket pins them.

## Cases to cover

- **Composite (multi-column) divergent FK.** Only single-column `pid → parent(id)` is exercised
  today. Add a two-column FK (e.g. `(a, b) → parent(a, b)`) with divergent basis vs logical
  actions and assert the logical action wins. `mappedFkBasisPairs` / `matchingBasisFks` are
  unordered-pair-set based, so a permuted basis FK must NOT match — worth a permuted-columns
  negative case too.

- **Exhaustive divergent matrix.** Tested pairs are setNull/cascade (delete+update),
  cascade/restrict (delete), setDefault/cascade (delete). Add the remaining divergent non-RESTRICT
  pairs that ride the same code path but are unpinned — e.g. logical `cascade` over basis
  `set null`, logical `set default` over basis `set null`, logical `set null` over basis
  `set default`, and the update-side variants.

- **Transitive / multi-level divergence.** A parent→child→grandchild chain where the
  parent→child FK diverges (basis cascade, logical set null) and child→grandchild carries a
  RESTRICT. Confirm the logical action's child-view DML re-entry enforces the grandchild RESTRICT
  (the step-2 suppression in `assertTransitiveRestrictsForParentMutation` is reasoned sound but
  untested). The existing non-divergent transitive cascade test still passes.

- **Multi-equivalent-basis-FK residual.** Two basis FKs over the identical columns with mixed
  actions: the walker fires when *any* match diverges and only the *divergent* matches are
  suppressed, so an *agreeing* same-action basis FK may also run (a double application of the same
  idempotent-ish action — never a dropped enforcement). Documented as sound-but-non-minimal; a
  test would pin the actual observed behavior. Hard to construct; lower priority.

- **Store backend (rowid-mode / lamina).** `yarn test:store` was not agent-runnable inside the
  shipping ticket (idle-timeout / wall-clock). Validate the divergent-action suite against the
  store module — particularly the suppressed-basis-cascade interaction with rowid-chained
  post-mutation scans. If a store-specific gap surfaces, escalate to a `fix/` ticket. This is the
  one item that could surface a real (backend-specific) defect rather than just adding a pin; run
  it out-of-band (human / CI) if it exceeds the agent wall-clock budget.

## Notes

- No production-code change is expected; if a test reveals divergence from the documented
  contract, split out a `fix/` ticket rather than patching here.
- The mechanism lives in `basisFksOverriddenByDivergentLensFk` /
  `matchingBasisFksForLensRef` / `matchingBasisFksCore` (`schema/lens-fk-discovery.ts`) and the
  four suppression sites (`runtime/foreign-key-actions.ts`,
  `planner/building/foreign-key-builder.ts`); see `docs/lens.md` § Foreign key.
