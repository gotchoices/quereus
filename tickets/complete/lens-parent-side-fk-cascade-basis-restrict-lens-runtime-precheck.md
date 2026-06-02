description: COMPLETE — a lens parent-side FK RESTRICT over a non-restrict basis FK is now enforced by a runtime pre-check (`assertLensRestrictsForParentMutation`, the logical dual of `assertNoRestrictedChildrenForParentMutation`), fired BEFORE the basis op so it observes the pre-cascade child state. Replaces the silently-dropped deferred `NOT EXISTS` that raced the same-statement basis CASCADE / SET NULL / SET DEFAULT.
files: packages/quereus/src/runtime/foreign-key-actions.ts, packages/quereus/test/lens-enforcement.spec.ts, packages/quereus/test/runtime/fk-restrict-runtime.spec.ts, docs/lens.md
----

# Lens parent-side FK RESTRICT over a non-restrict basis (runtime pre-check)

## What shipped

A **logical** FK with a RESTRICT op-action over a **non-restrict basis** FK (basis
`cascade` / `set null` / `set default`) — or over no basis FK — was silently unenforced
for the cascade case: the collector retained a deferred commit-time `NOT EXISTS`, but the
same-statement basis cascade mutated the children mid-statement, so the deferred check
observed the **post-cascade** (empty) child state and passed. The parent delete succeeded
and the children were cascade-deleted, when the lens RESTRICT should have **ABORTed**.

The fix is the **logical dual** of the existing physical RESTRICT pre-check, fired at the
same pre-mutation timing:

- **`assertLensRestrictsForParentMutation`** (`runtime/foreign-key-actions.ts`) reverse-maps
  the basis parent table → logical parent slot(s) (single-basis-spine boundary, identical to
  the cascade walker), discovers referencing logical FKs (`findLogicalParentFkRefs`), and for
  each whose op-appropriate logical action is `restrict` scans the **logical child view**
  (`select 1 from <schema>.<child> where <childLogicalCol> = ? … limit 1`, OLD values bound).
  A surviving row ⇒ throws `StatusCode.CONSTRAINT` with a message parallel to the physical
  pre-check (logical table names).
- **Wiring:** called from `assertTransitiveRestrictsForParentMutation` step 1b, immediately
  after the physical `assertNoRestrictedChildrenForParentMutation`. All three DML-executor
  call sites (`processDeleteRow`, `processUpdateRow`, `processEvictions`) already invoke the
  transitive walker before the vtab op, so the lens scan rides along — and re-fires at each
  recursion level, giving transitivity through basis cascades.
- **Shared helper `resolveLensFkParentReferencedValues`** (OLD/NEW basis-value extraction +
  MATCH SIMPLE skip + UPDATE `sqlValuesEqual` short-circuit) factored out of the cascade
  walker so the cascade and RESTRICT paths cannot drift.
- **docs/lens.md** § Constraint Attachment updated.

The collector is unchanged; the deferred `NOT EXISTS` stays as harmless commit-time
defense-in-depth.

## Review findings

Read the implement diff (`90f63a17`) with fresh eyes before the handoff. Build (`tsc`) and
lint (`eslint`) both clean; full memory-backend suite **4376 passing, 9 pending, 0 failing**
(4375 prior + the multi-hop test added below).

### Checked — correctness & design
- **Timing / wiring** — the pre-check fires inside `assertTransitiveRestrictsForParentMutation`
  step 1b, which all three DML sites call BEFORE `vtab.update`. Confirmed it observes the
  pre-cascade child state. ✓
- **Transitivity** — verified by reasoning *and* by a new test: the step-2 recursion through
  a basis cascade re-enters the walker, which re-fires step 1b at the deeper level. A lens
  RESTRICT two hops down through a basis cascade ABORTs the top-level delete before any
  mutation. ✓ (was an explicitly-flagged "belt-and-suspenders" gap — now closed.)
- **Interaction with the divergent-action mechanism** (`basisFksOverriddenByDivergentLensFk`)
  — no overlap: that suppression acts only on **non-RESTRICT** logical actions; the pre-check
  acts only on **RESTRICT** logical actions. Mixed slots (a divergent-cascade child + a
  RESTRICT child on the same parent) resolve correctly — the RESTRICT child blocks, the
  cascade never runs. ✓
- **Collector / redundancy elision** (`lensParentSideForeignKeyRedundant`) — unchanged;
  returns "enforce" whenever any matching basis FK is non-`restrict`, so the deferred check
  is retained exactly where the pre-check is needed. ✓
- **Double-fire safety** (lens-only no-basis-FK case: pre-check + retained deferred check) —
  an unreferenced parent matches neither; a referenced parent ABORTs at the pre-check before
  the deferred one is reached. No spurious failure path. ✓
- **MATCH SIMPLE + UPDATE short-circuit** — shared `resolveLensFkParentReferencedValues`,
  `sqlValuesEqual`-based, null-safe for the nullable value→NULL key change. Aligned with the
  deferred check's `is not distinct from`. ✓
- **DRY** — the extraction helper is a genuine dedup (cascade walker now delegates to it),
  not a copy. ✓
- **Resource cleanup / type safety / error handling** — `stmt.finalize()` in `finally`; no
  `any`; `QuereusError(StatusCode.CONSTRAINT)`; message matcher-compatible with
  `/constraint|foreign|fk/i`. ✓
- **pragma gate, composite keys, SET NULL / SET DEFAULT, benign-UPDATE short-circuit** — all
  covered by the implementer's suite and passing. ✓

### Found & fixed in this pass (minor)
- **Misleading test title** — the pragma-gate test was titled
  `(basis CASCADE runs, child cascade-deleted)`, but with `foreign_keys = false` *no* FK
  enforcement fires (the basis cascade is gated off too) and the body correctly asserts the
  child is **orphaned**, not cascade-deleted. The title contradicted its own assertions.
  Renamed to `(no FK enforcement, child orphaned)`.
- **Added the flagged multi-hop transitive test** —
  `transitive — a lens RESTRICT two hops down (through a basis cascade) ABORTs the top-level
  parent delete` in `lens-enforcement.spec.ts`. parent → mid (basis+logical cascade, agreeing)
  → leaf (basis cascade, logical bare ⇒ RESTRICT). Deleting parent ABORTs atomically (all
  three rows survive); once leaf is removed the delete cascades cleanly. Pins the transitivity
  claim against regression.

### Major findings
None. No new fix/plan/backlog tickets filed.

### Known gaps carried forward (not defects)
- **Store backend (lamina) not validated** — `yarn test:store` is not agent-runnable inside a
  ticket (wall-clock). The pre-check is a backend-agnostic pre-mutation view scan riding the
  same point as the proven physical pre-walk (which exists precisely for rowid-chained
  backends), so the risk is low. If a store-specific gap surfaces in CI, file a backlog ticket
  rather than expanding scope.
- **`lens-parent-side-fk-nullable-key-update-gap`** is *partly* mitigated as a side effect
  (the pre-check uses `sqlValuesEqual`) but **not** closed — that ticket targets the plan-time
  guard's plain-`=` miss.
- **Message shape** — the thrown message uses **logical** table names (the physical pre-check
  uses basis names); reviewed as acceptable parity.
- **Performance note** (not introduced by this ticket) — `basisFksOverriddenByDivergentLensFk`
  and `findLogicalParentFkRefs` are recomputed across the several FK passes per mutation; all
  are cheap-empty for non-lens databases (`getAllLensSlots()` empty). Acceptable; flagged for a
  future consolidation if lens DBs ever become hot.

## End
