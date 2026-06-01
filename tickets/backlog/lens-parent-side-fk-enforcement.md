description: Enforce the parent side of a logical foreign key at the lens write boundary — deleting or updating a logical *parent* row through the lens must run the RESTRICT existence check (and, eventually, the CASCADE / SET NULL / SET DEFAULT actions) against the logical *child* relation, symmetric to the child-side existence check that `lens-fk-enforcement-wiring` shipped.
prereq:
files: packages/quereus/src/planner/mutation/lens-enforcement.ts, packages/quereus/src/planner/building/foreign-key-builder.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/src/runtime/foreign-key-actions.ts
----

## Context

`lens-fk-enforcement-wiring` made a logical FK's **child-side** existence check
live at the lens boundary: an insert/update through a lens-backed logical *child*
table that introduces a dangling logical reference is now rejected (a deferred
synthesized `EXISTS` against the logical parent, gated by `foreign_keys`). That
ticket was deliberately **child-side only**.

The **parent side** is still unenforced through the lens. The physical
parent-side machinery — `buildParentSideFKChecks` (RESTRICT/NO ACTION → a
`NOT EXISTS` over the child) and `runtime/foreign-key-actions.ts`
(CASCADE / SET NULL / SET DEFAULT) — both discover FKs by scanning declared
`TableSchema.foreignKeys` on **basis** tables. A logical FK lives only on the
logical child table's slot, not on any basis table, so:

- Deleting a logical parent row through the lens does **not** run a RESTRICT
  existence check against the logical children — it can orphan logical child
  rows that still reference the deleted key.
- Updating a logical parent's referenced columns through the lens does not run
  the parent-side RESTRICT / cascade either.

This is the exact mirror of the child-side gap that `lens-fk-enforcement-wiring`
closed, and is currently documented as "out of scope" in `docs/lens.md`
(§ Constraint Attachment, Foreign key bullet: "Parent-side FK actions through the
lens are out of scope").

## Expected behavior

A `delete`/`update` through a lens-backed logical table that is the **referenced
(parent)** relation of some logical FK should enforce that FK's parent-side
semantics with the same gating and timing as a physical parent-side FK:

- **RESTRICT / NO ACTION** — reject the parent mutation if a logical child row
  still references the affected key (a `NOT EXISTS` over the logical child,
  child columns in logical terms, resolved against the registered logical child
  relation), gated by the `foreign_keys` pragma.
- **CASCADE / SET NULL / SET DEFAULT** — propagate the action to the logical
  child rows. (May be a later slice than RESTRICT; RESTRICT/NO-ACTION detection
  is the minimum viable parent-side guarantee and can ship first.)

The discovery problem is the crux: parent-side enforcement must find logical FKs
**declared on other logical tables' slots that reference this logical table**,
not basis `foreignKeys`. That cross-slot lookup (analogous to how
`buildParentSideFKChecks` scans all schemas for referencing basis tables) is the
new machinery this ticket needs.

## Notes / boundaries

- Child-side existence already ships and is unaffected — this is purely the
  parent-side complement.
- Same single-source-spine limitation the child-side and row-local classes carry
  applies (multi-source / decomposition logical tables route extras only on the
  single-source spine); do not regress that, and document any parent-side
  equivalent of the limitation.
- The redundancy-elision concern (double-enforcement when the basis already
  carries an equivalent FK) is tracked separately for the child side in
  `lens-fk-basis-redundancy-elision`; the same question will exist for the parent
  side and can be folded into that effort or noted there.
- Reuse `synthesizeNotExistsCheck` / the shared `synthesizeFKSubquery` seam in
  `planner/building/foreign-key-builder.ts` (extended with the logical FROM-schema
  qualification the child-side collector already added) rather than authoring a
  second `NOT EXISTS` synthesizer.
