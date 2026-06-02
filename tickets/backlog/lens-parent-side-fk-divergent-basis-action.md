description: When a lens-backed logical parent and its basis child both carry a parent-side FK over the SAME equivalent columns but with DIVERGENT referential actions (e.g. logical `on delete set null` over basis `on delete cascade`, or a logical CASCADE over a basis RESTRICT), the basis action governs and the logical FK's action is not honored. `lens-parent-side-fk-cascade-actions` elides the logical cascade whenever an equivalent basis FK exists, so the basis path is the only one that runs. Resolve divergence so the *logical* FK's action wins.
files: packages/quereus/src/runtime/foreign-key-actions.ts, packages/quereus/src/planner/mutation/lens-enforcement.ts, packages/quereus/src/schema/lens-fk-discovery.ts, docs/lens.md
----

## Problem

`lens-parent-side-fk-cascade-actions` makes a lens-backed logical parent propagate
CASCADE / SET NULL / SET DEFAULT to its logical children, via a runtime walker that issues
the propagating DML against the logical child view. To compose with the physical cascade
walker (`executeForeignKeyActions`) and avoid double-mutation, it **elides** the logical
cascade whenever the basis child carries a structurally-equivalent FK referencing the basis
parent — letting the basis action run alone.

That is correct when the basis and logical actions **agree** (the basis cascade does exactly
what the logical cascade would). When they **diverge** over the same equivalent columns, the
basis action governs and the logical contract is silently not honored:

- Logical `on delete set null` over basis `on delete cascade` → the basis deletes the child
  rows; the logical SET NULL never applies (children gone, not nulled).
- Logical `on delete cascade` (or set null / set default) over basis `on delete restrict` →
  the basis RESTRICT pre-check (`assertNoRestrictedChildrenForParentMutation` /
  `buildParentSideFKChecks`) aborts the parent mutation before any logical cascade can run, so
  the logical CASCADE never fires.

## Why parked

- **Narrow + pathological.** It requires the *basis* child to carry an equivalent FK whose
  parent-side action differs from the logical FK's. The canonical lens shape has the action on
  the logical FK only (basis action-free), where divergence cannot arise. Declaring two
  different parent-side actions for the same columns across the two layers is an unusual
  configuration.
- **Same hard family as `lens-parent-side-fk-cascade-basis-restrict-lens-not-enforced`** (the
  in-flight fix for lens RESTRICT over basis non-RESTRICT): both are "the lens's action must win
  over a same-statement basis action that already mutated/blocked the children." Resolving it
  cleanly likely needs the logical action to run **instead of** (not after) the basis action —
  e.g. suppressing the basis referential action for the equivalent columns when a logical FK
  overrides it, or running the logical propagation pre-basis-mutation. That is a coordinated
  change across the physical and lens walkers, out of scope for the cascade-actions slice.

## Acceptance (when promoted)

- Decide and document the intended semantics: the **logical** FK's parent-side action is the
  authoritative contract and must win over a divergent basis action on the same equivalent
  columns.
- A logical `set null` / `set default` over a basis `cascade` nulls/defaults the children
  (does not delete them); a logical `cascade` over a basis `restrict` cascades (is not aborted
  by the basis RESTRICT).
- No double-mutation; composes with the transitive physical walker and cycle termination.
- Tests for each divergent (basis action × logical action) pair on DELETE and UPDATE.
- Update `docs/lens.md` to drop the divergent-action limitation once closed.
