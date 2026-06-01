description: Propagate CASCADE / SET NULL / SET DEFAULT parent-side actions for a logical foreign key through the lens — deleting/updating a logical parent row should cascade (delete / null / default) the referencing logical child rows, the action complement to the RESTRICT/NO-ACTION parent-side detection that `lens-parent-side-fk-enforcement` ships.
prereq: lens-parent-side-fk-enforcement
files: packages/quereus/src/planner/mutation/lens-enforcement.ts, packages/quereus/src/runtime/foreign-key-actions.ts, packages/quereus/src/planner/building/view-mutation-builder.ts
----

## Context

`lens-parent-side-fk-enforcement` makes the parent side of a logical FK enforce
**RESTRICT / NO ACTION** at the lens boundary (a synthesized `NOT EXISTS` over the
logical child on DELETE/UPDATE of a lens-backed logical parent). It deliberately stops
at detection: it rejects an orphaning mutation but does not **propagate** an action.

The physical CASCADE / SET NULL / SET DEFAULT machinery lives in
`runtime/foreign-key-actions.ts` (`executeForeignKeyActions`,
`assertTransitiveRestrictsForParentMutation`, `executeSingleFKAction`) and discovers
FKs by scanning basis `TableSchema.foreignKeys`. A logical FK lives only on the child
slot's `obligations`, so a logical parent mutation through the lens runs no logical
cascade — the action is silently a no-op (or, when the lens declares RESTRICT, the
parent-side detection rejects).

## Expected behavior

A `delete`/`update` through a lens-backed logical parent whose referencing logical FK
declares `cascade` / `setNull` / `setDefault` should propagate that action to the
**logical child** rows (issuing the cascading delete/update **through the logical
child relation**, in logical terms, so each cascade re-enters the lens write path and
its own constraints fire), with the same gating (`foreign_keys`) and cycle-detection
as the physical cascade walker. SET DEFAULT resolves the logical child column's
declared default.

## Notes / boundaries

- Cross-slot discovery is shared with the RESTRICT collector
  (`collectLensParentSideForeignKeyConstraints` cross-slot scan over
  `getAllLensSlots()` × `enforced-fk` obligations) — reuse that seam; here the action
  gate is `cascade` / `setNull` / `setDefault` instead of `restrict`.
- A logical cascade is a *write* propagation, not a plan-time `NOT EXISTS`, so it does
  not fit the `extraConstraints` seam the RESTRICT side rides. It likely needs a
  runtime hook analogous to `executeForeignKeyActions` but driven off the logical
  child relation (issue the cascade SQL against the logical view, which re-plans
  through the lens write substrate), or a planner-level fan-out. Design is open —
  this is a larger slice than the RESTRICT detection and was split out on purpose.
- Transitive cascades / cycle detection must compose with the physical walker so a
  mixed logical/basis FK graph does not double-cascade or miss a cycle.
- Same single-source-spine limitation the RESTRICT side carries applies.
