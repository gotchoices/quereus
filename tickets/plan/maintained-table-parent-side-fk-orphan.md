description: A maintenance-driven delete/update to a maintained table that is the PARENT of a foreign key declared on another table can orphan child rows, bypassing parent-side RESTRICT / cascade — the derivation's own writes don't run parent-side FK enforcement.
files:
  - packages/quereus/src/core/database-materialized-views.ts            # maintainRowTime / applyMaintenancePlan (the derivation delete/update site)
  - packages/quereus/src/planner/building/foreign-key-builder.ts        # buildParentSideFKChecks (parent-side NOT EXISTS / RESTRICT)
  - packages/quereus/src/runtime/foreign-key-actions.ts                 # cascade / set-null action execution
----

# Parent-side FK orphaning by maintained-table derivation writes

The ticket `maintained-table-derivation-check-fk-validation` covers
**child-side** FKs declared *on* a maintained table (the maintained table
referencing parents). It deliberately does **not** cover the inverse: a maintained
table that is itself the **parent** (FK target) of an FK declared on some other
(ordinary) table.

When steady-state maintenance deletes or key-updates a derived row in such a
parent maintained table, the derivation writes through the privileged backing
surface and never runs the parent-side FK enforcement
(`buildParentSideFKChecks` — the RESTRICT `NOT EXISTS` guard, or the
ON DELETE/UPDATE CASCADE / SET NULL actions in `foreign-key-actions.ts`). So a
source write that removes/relocates a parent derived row can leave orphaned
child rows in an ordinary table, silently violating that table's FK.

This is a real gap but distinct from the in-scope work:
  - it concerns FKs declared **elsewhere**, not constraints declared on the
    maintained table;
  - it requires running parent-side enforcement / referential actions from the
    maintenance delete/update path, not validating a written row image;
  - referential **actions** (CASCADE/SET NULL) would have maintenance writes
    trigger *further* user-table writes, which is a larger semantic and
    transactional question.

## Open questions for a future plan pass

- Should a maintained parent even be allowed as an FK target, or should
  declaring an FK that references a maintained table be rejected (parity with
  "the body is the contract")?
- If allowed: does a maintenance delete of a referenced parent row enforce
  RESTRICT (fail the source write), or execute the declared referential action
  against the child table (cascade the delete)?
- Transactional shape: a maintenance write triggering child-table cascades
  during the source-write flush — interaction with the deferred-rebuild flush and
  the MV-over-MV cascade ordering.

Promote to `plan/` when the child-side ticket has landed and there is appetite to
close the parent-side gap.

## Triage decision (2026-06-12, human sign-off)

**Full referential actions** — with the explicit condition that the
infrastructure built for it must improve the general architecture, not be a
maintained-table special case. Concretely: a maintenance delete/key-update of a
referenced parent row enforces RESTRICT (failing the source-write statement,
attributed to the maintained table) and executes declared CASCADE / SET NULL
against child tables. The plan pass should design this as a generalization of
the existing parent-side enforcement machinery (`buildParentSideFKChecks`,
`foreign-key-actions.ts`) so the same kernel serves ordinary-table writes,
view-routed writes (the lens cascade walker), and maintenance writes — one
referential-action engine with multiple entry points, rather than a third
copy. Key design questions for the plan pass: transactional shape of a
maintenance write triggering child-table writes mid-flush (interaction with
deferred-rebuild and MV-over-MV cascade ordering); whether the cascaded child
write re-enters the full write path (it should — constraints, watches, and
nested cascades fire for free, matching the lens walker's issue-against-the-view
precedent); and recursion termination.
