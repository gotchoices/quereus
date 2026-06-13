description: Extend test coverage for parent-side referential enforcement on the maintained-table maintenance write path to the remaining maintenance arms (join-residual, prefix-delete), cross-schema FKs, and the LevelDB store backend — the arm-agnostic hook is now proven on inverse-projection + aggregate; the rest are covered only structurally.
files:
  - packages/quereus/test/runtime/maintained-parent-fk.spec.ts                 # the existing 18-case matrix to extend
  - packages/quereus/src/core/database-materialized-views.ts                    # enforceParentSideReferentialActions (the seam under test) + applyForwardResidual (join-residual) + applyPrefixDelete arms
  - packages/quereus/src/runtime/foreign-key-actions.ts                         # reused engine (handles fk.referencedSchema; SET DEFAULT rowid-chained caveat)
difficulty: easy
----

# Parent-side FK enforcement on maintained tables — remaining arm / backend coverage

## Context

`maintained-table-parent-side-fk-orphan` landed (and was reviewed): a maintenance
delete/key-update of a maintained table `M` that is an FK **parent** now fires the shared
referential-action engine instead of orphaning child rows. The enforcement hook
(`MaterializedViewManager.enforceParentSideReferentialActions`) operates on the
`BackingRowChange[]` the apply arms return, so it is **arm-agnostic** — there is no per-arm
code.

Coverage today (`test/runtime/maintained-parent-fk.spec.ts`, 18 cases) directly exercises the
hook on **two** genuinely-distinct delete-producing apply paths:

- `inverse-projection` (covering-index body) — RESTRICT / CASCADE / SET NULL / SET DEFAULT /
  ON UPDATE CASCADE / ON UPDATE RESTRICT;
- `residual-recompute` (aggregate) — CASCADE / RESTRICT on an emptied group + a non-emptying
  decrement no-op (added in review);
- plus `full-rebuild` floor, MV-over-MV intermediate parent, a converging feedback loop, and
  the negative/no-op cases.

## What's still uncovered (the work)

These are **low risk** (the hook is arm-agnostic and proven on two arms), but genuinely untested
on the maintenance seam — worth closing for completeness, not because a defect is suspected.

- **`join-residual` arm** (1:1 inner/cross join, `applyForwardResidual`): a maintenance write that
  drops the one joined backing row a child references should fire the parent-side action. Needs a
  provable-1:1 body (NOT-NULL FK→PK, unique driving PK) — mirror an existing join-residual setup in
  `test/incremental/`.
- **`prefix-delete` arm** (single-source lateral-TVF fan-out): a source change that shrinks/empties
  a fan-out slice produces backing `delete-key`s; a child referencing one of those backing rows
  should see the action.
- **Cross-schema FK**: an FK in schema `s2` referencing `M` in `main`. The engine already keys off
  `fk.referencedSchema ?? childTable.schemaName`, but no maintenance-path test pins it. Needs an
  `attach`-ed second schema (confirm the memory backend supports it; otherwise note the limitation).
- **Store backend** (`yarn test:store`): the implement+review passes ran the memory backend only.
  Re-run at least the RESTRICT / CASCADE / SET DEFAULT cases against the LevelDB store. SET DEFAULT
  carries the engine's documented rowid-chained-backend caveat (see `foreign-key-actions.ts`
  `executeSingleFKAction` / the recursion comment), so the store path may differ for SET DEFAULT
  and for the residual arms' live re-reads — verify or document divergence.

## Notes

- The enforcement code itself needs no change; this is test-only (plus any doc note if a backend
  divergence is found).
- The PK-move ON UPDATE case (a key-move on `M`'s PK decomposes to delete+insert ⇒ observes
  ON DELETE) was reviewed and accepted as intended/non-regressive — no test owed, but a
  documentation-only assertion test could pin the contract if desired.
