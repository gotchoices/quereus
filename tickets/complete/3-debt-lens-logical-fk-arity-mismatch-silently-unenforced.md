---
description: A foreign key on a logical (lens) table that cannot be checked — its column count does not match the parent's key, or its parent table does not exist — used to be silently ignored. It is now refused when the logical schema is applied (where that can be decided) and otherwise fails the write, matching ordinary tables.
architecture: docs/lens-constraints.md#foreign-key
files:
  - packages/quereus/src/schema/table.ts                         # foreignKeyArityMismatchMessage / foreignKeyMissingParentReason / foreignKeyMissingParentMessage
  - packages/quereus/src/planner/building/foreign-key-builder.ts  # synthesizeFKAbsentParentExpr + fkAbsentParentViolationMessage (shared by physical + lens)
  - packages/quereus/src/schema/lens-fk-discovery.ts              # resolveLogicalFkParent, checkLogicalFkReferencedColumns, unenforceableLogicalFkDiagnostics, findLogicalParentFkRefs → { refs, unenforceable }, raiseUnenforceableLogicalParentFk
  - packages/quereus/src/schema/lens-compiler.ts                  # deployLogicalSchema: post-compile-loop FK pass into proveErrors
  - packages/quereus/src/planner/mutation/lens-enforcement.ts     # child-side throw / absent-parent check; parent-side RESTRICT raise
  - packages/quereus/src/runtime/foreign-key-actions.ts           # cascade walker + runtime RESTRICT raise
  - packages/quereus/test/logic/41.16-fk-unenforceable.sqllogic   # section C
  - docs/lens-constraints.md, docs/lens-prover.md, docs/sql-constraints.md, docs/schema.md
---

# What shipped

A logical FK that cannot be checked is no longer skipped (with only a debug log) at the lens enforcement sites. Two layers, landed in `ticket(implement): debt-lens-logical-fk-arity-mismatch-silently-unenforced`:

- **`apply schema` refusal** (`unenforceableLogicalFkDiagnostics`, run after the compile loop so a parent declared after its child resolves): `lens.unrealizable-constraint` for a column-count mismatch against a same-schema parent (resolved against the declaration being deployed, not the catalog) or an already-registered other-schema parent, and for a same-schema parent missing from the declaration. An absent other-schema parent is a legal forward reference.
- **Write-time raise**: child side throws the shared column-count message at plan time, or emits the MATCH SIMPLE null-guards-only check naming the missing `<schema>.<table>`; parent side, `findLogicalParentFkRefs` returns `{ refs, unenforceable }` and the plan-time RESTRICT collector, the runtime RESTRICT pre-check and the cascade walker each raise for the unenforceable keys their own action filter selects. The basis FK gate counts unenforceable keys so the runtime paths are reached.
- Inbound FKs from another logical schema are deliberately not checked when the parent schema is re-applied (would deadlock a legitimate change) — documented in `docs/lens-constraints.md` § Foreign key.

Messages are shared with the physical path (`foreignKeyArityMismatchMessage`, `fkAbsentParentViolationMessage`), and the physical builder now uses the same absent-parent helpers.

# Review findings

**Checked:**

- Read the full implement diff before the handoff. Compared every lens raise site with its physical counterpart (`buildChildSideFKChecks`, `buildParentSideFKChecks`, `executeForeignKeyActions`, `assertNoRestrictedChildrenForParentMutation`): both raise before any referenced-column-changed short-circuit and after their action filter, so parity holds (an `update` not touching the key still fails on a RESTRICT key, as physically).
- The lens cascade walker and runtime RESTRICT pre-check are only entered for lens-routed writes (`executeForeignKeyActionsAndLens` / `assertTransitiveRestrictsForParentMutation` gate on `lensRouted`), so a direct basis-table write is never failed by an unenforceable *logical* key. Confirmed by probe.
- The prover classifies every logical FK as `enforced-fk` (`classifyConstraint`), so iterating `enforcedLogicalFks` at deploy covers every declared logical FK on a proved slot.
- The same-schema `findTable` backstop in the deploy pass cannot resurrect a previous deploy's logical table: logical tables are registered as views, which `findTable` does not return. Confirmed by probe (redeploy that drops the parent but keeps the child → refused naming `x.p1`).
- Ad-hoc probes (scratch script, not committed) beyond the corpus: self-referencing defaulted FK against a two-column key → refused; logical FK to a *physical* basis table with mismatched key → refused at deploy naming the physical parent; `on delete cascade` key after the parent is widened → lens delete raises from the cascade walker, `update` raises from the plan-time RESTRICT collector (default `on update` is RESTRICT), and a direct basis delete still succeeds.
- Error handling: raised errors are `QuereusError(StatusCode.ERROR)`; the deploy refusal goes through the atomic `proveErrors` throw, so a refused re-apply leaves prior lens state untouched. No exceptions swallowed; the removed debug-log skips were the defect.
- Type safety: `checkLogicalFkReferencedColumns` returns a discriminated union; `UnenforceableLogicalParentFk` kept separate from `LogicalParentFkRef` so refs stay well-formed. No `any`.
- Tests: the four new corpus cases (C1–C4) each pin a distinct branch (same-schema mismatch, same-schema absent, cross-schema absent, cross-schema re-apply across child / plan-time RESTRICT / cascade walker). The `lens-enforcement.spec.ts` edits are mechanical `.refs` call-site updates. Nothing cut, nothing added.
- Validation: `yarn workspace @quereus/quereus lint` clean; `yarn workspace @quereus/quereus test` 11194 passing, 26 pending, 0 failing. Store mode not re-run in review (implement ran the 41.16 / 51-lens / 55-lens corpora under `QUEREUS_TEST_STORE=true`; the review change is doc-only).

**Found and fixed (minor):**

- `docs/schema.md` (lens basis FK gate paragraph) still described the gate as `findLogicalParentFkRefs(slot).length > 0` — stale after the return-shape change and silent on unenforceable keys. Updated to say the gate counts both well-formed and unenforceable referencing keys, and why.

**Major findings:** none.

**Tripwires / conditional:** none new. The handoff's known gaps were re-checked and stand as documented boundaries, not defects: the runtime RESTRICT raise is defense in depth (plan-time raises first; redeploy re-plans via `lens_view_replaced`); multi-source / decomposition parents are outside the parent-side single-source-spine boundary for well-formed keys too; a written `referencedColumnNames` naming a non-existent parent column surfaces as a plan-time column-resolution error rather than a deploy refusal (out of scope).

**Source hygiene:** `lens-enforcement.ts` (1500 lines), `foreign-key-actions.ts` (1188), `table.ts` (1944) measured with `wc -l`; all were large before this change, which adds little net, and file size is already tracked by `debt-oversized-source-files`. Minor inconsistency left as is: the plan-time collector passes an inline `action => action === 'restrict'` while the runtime file has a local `isRestrictAction`; sharing it would mean exporting a one-line predicate across layers.
