description: Elide the lens-level parent-side FK check (the synthesized `NOT EXISTS`) when the re-planned basis parent write provably already enforces an equivalent parent-side FK — the parent-side complement of `lens-fk-basis-redundancy-elision`, which closed the same double-enforcement for the child side.
prereq: lens-parent-side-fk-enforcement
files: packages/quereus/src/planner/mutation/lens-enforcement.ts
----

## Context

`lens-fk-basis-redundancy-elision` (shipped) stopped the lens child-side `EXISTS` from
double-enforcing when the basis child write already carries an equivalent FK
(`lensForeignKeyRedundant` — single-source value-preserving child mapping + equivalent
unordered basis FK pair-set + non-row-reducing logical-parent projection; any
uncertainty defaults to double-enforce).

`lens-parent-side-fk-enforcement` (the RESTRICT/NO-ACTION parent side) intentionally
ships **double-enforcing**: it emits the parent-side `NOT EXISTS` over the logical
child even when the basis parent write's own `buildParentSideFKChecks` already enforces
an equivalent parent-side FK. That is always sound (both reject the same orphaning
condition) but pays a redundant scan.

## Expected behavior

When the basis parent write provably already enforces an equivalent parent-side FK —
i.e. the same three structural conditions `lensForeignKeyRedundant` checks, read from
the parent direction (the *referencing* basis FK exists with a matching unordered
pair-set referencing the basis parent, the logical child is a faithful non-row-reducing
projection of the basis child, and the parent referenced columns map plainly to basis
columns) — the lens-level parent-side check is **elided** (logged on the
`planner:lens-enforcement` channel). Any uncertainty defaults to enforce.

## Notes / boundaries

- Reuse / generalize the existing `lensForeignKeyRedundant` helpers
  (`mappedFkBasisPairs`, `basisCarriesEquivalentFk`, `isNonRowReducingProjection`)
  rather than authoring a parallel set — they already encode the pair-set + projection
  reasoning, just for the child direction.
- **Action-mismatch caveat to resolve here:** a logical FK declaring RESTRICT whose
  *basis* FK declares CASCADE is not redundant — the basis re-plan would cascade-delete
  children while the lens RESTRICT would reject. The elision must require the basis
  FK's action to match (or be at least as strict as) the logical FK's, not merely that
  an equivalent FK exists. Folding this is the reason the parent-side elision was split
  from the shipped child-side ticket (where actions don't enter the child-side
  existence check).
