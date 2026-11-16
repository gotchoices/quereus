---
description: A foreign key on a logical (lens) table that cannot be checked — its column count does not match the parent's key, or its parent table does not exist — used to be silently ignored. It is now refused when the logical schema is applied (where that can be decided) and otherwise fails the write, matching ordinary tables.
architecture: docs/lens-constraints.md#foreign-key
files:
  - packages/quereus/src/schema/table.ts                         # foreignKeyArityMismatchMessage / foreignKeyMissingParentReason / foreignKeyMissingParentMessage (extracted from resolveReferencedColumnsForEnforcement)
  - packages/quereus/src/planner/building/foreign-key-builder.ts  # synthesizeFKAbsentParentExpr + fkAbsentParentViolationMessage (shared by physical + lens)
  - packages/quereus/src/schema/lens-fk-discovery.ts              # resolveLogicalFkParent, logicalReferencedColumnNames, checkLogicalFkReferencedColumns, unenforceableLogicalFkDiagnostics, findLogicalParentFkRefs → { refs, unenforceable }, raiseUnenforceableLogicalParentFk
  - packages/quereus/src/schema/lens-compiler.ts                  # deployLogicalSchema: post-compile-loop FK pass into proveErrors
  - packages/quereus/src/planner/mutation/lens-enforcement.ts     # collectLensForeignKeyConstraints (throw / absent-parent check), collectLensParentSideForeignKeyConstraints (raise for RESTRICT)
  - packages/quereus/src/runtime/foreign-key-actions.ts           # executeLensFkActionsForParentSlot, assertLensRestrictsForParentSlot
  - packages/quereus/test/logic/41.16-fk-unenforceable.sqllogic   # new section C
  - packages/quereus/test/lens-enforcement.spec.ts                # findLogicalParentFkRefs(...).refs call sites
  - docs/lens-constraints.md, docs/lens-prover.md, docs/sql-constraints.md
---

# What changed

A logical FK whose child column count differs from the parent key it resolves to (only the defaulted `references <parent>` form can reach this), or whose parent does not exist, was skipped with a debug log at every enforcement site: orphans accepted, RESTRICT bypassed. Now two layers:

## Layer 1 — `apply schema` refuses what it can decide

`deployLogicalSchema` runs `unenforceableLogicalFkDiagnostics` after the compile loop, before the atomic `proveErrors` throw. For every compiled slot's `enforced-fk` obligation:

- Parent in the schema being deployed → resolved against this deploy's compiled slots by name (then a `findTable` backstop for a physical table in that schema), never the registered catalog (which still holds the previous deploy).
- Parent in another schema → resolved against the catalog (lens slot, then `findTable`), same as enforcement.
- Arity mismatch → `lens.unrealizable-constraint` error with the physical wording (`Foreign key '<fk>' on table '<schema>.<child>': N column(s) reference the primary key of '<schema>.<parent>', which has M column(s).`).
- Same-schema parent absent → `lens.unrealizable-constraint`: `Foreign key '<fk>' on table '<schema>.<child>': referenced table '<schema>.<parent>' does not exist.`
- Other-schema parent absent → no diagnostic (legal forward reference).

Inbound FKs from other logical schemas are deliberately **not** checked when a parent schema is re-applied (would deadlock a legitimate change); reasoning is in `docs/lens-constraints.md` § Foreign key.

## Layer 2 — enforcement raises instead of skipping

- **Child side** (`collectLensForeignKeyConstraints`, plan time, insert/update only): arity mismatch throws the shared message; absent parent emits the MATCH SIMPLE null-guards-only check (`NEW.c IS NULL OR … OR 0`) with `violationMessage` `CHECK constraint failed: lens:fk:<name> — referenced table '<schema>.<parent>' does not exist`. The physical builder now uses the same two helpers.
- **Parent side**: `findLogicalParentFkRefs` now returns `{ refs, unenforceable }` and never throws. `buildLensBasisFkGate` counts both lists; `basisFksOverriddenByDivergentLensFk` ignores `unenforceable`. `collectLensParentSideForeignKeyConstraints` (plan-time) and `assertLensRestrictsForParentSlot` (runtime pre-check) raise for an unenforceable RESTRICT key; `executeLensFkActionsForParentSlot` (cascade walker) raises for an unenforceable cascade / set null / set default key — via `raiseUnenforceableLogicalParentFk`, applying the same action filter each site applies to well-formed refs.

Well-formed logical FKs behave as before (existing lens suites unchanged and passing).

# Tests added

All in `test/logic/41.16-fk-unenforceable.sqllogic` section C (the corpus for this class):

- **C1** — same-schema defaulted arity mismatch → `apply schema` refused with code + physical wording.
- **C3** — same-schema absent parent → `apply schema` refused naming `lfk_x3.nothere`.
- **C4** — cross-schema absent parent → deploy succeeds; NULL-FK insert admitted; non-NULL insert fails naming `lfk_ghost.parent`.
- **C2** — cross-schema parent re-applied with a two-column PK after a working deploy (enforcement first shown working). Then: child insert fails with the arity message (plan-time child side); `delete` on the parent fails (plan-time RESTRICT collector); `update … set py` on the parent fails (the FK is `on update cascade`, so this reaches the **runtime cascade walker** raise). Data unchanged afterwards.

# Validation run

- `yarn workspace @quereus/quereus test` — 11194 passing, 26 pending, 0 failing.
- `yarn workspace @quereus/quereus lint` — clean.
- Store mode: `QUEREUS_TEST_STORE=true` mocha over `41.16`, `51-lens`, `55-lens` corpora — passing. (Full `yarn test:store` not run.)

# Known gaps / things to look at

- The runtime RESTRICT pre-check raise (`assertLensRestrictsForParentSlot`) is not reached by any test: for a lens-routed write the plan-time collector raises first, and a redeploy re-plans prepared statements (`lens_view_replaced`). It is defense in depth, kept for parity with the physical runtime sites.
- Multi-source / decomposition logical parents: parent-side sites skip them before discovery (the documented single-source-spine boundary), so an unenforceable key against such a parent is not raised parent-side — same as a well-formed key is not enforced there.
- The deploy pass checks FK obligations on every compiled slot, including read-only ones (a read-only child cannot be written, but its FK still participates parent-side).
- An explicit `referencedColumnNames` that names a column the logical parent does not have is still not checked at deploy (out of scope; would surface as a plan-time column-resolution error on the synthesized `EXISTS`).
- Child-side arity throw is plan-time, so it fails every insert/update through the child, NULL FK value or not — same as the physical path (41.16 B1).
