description: Review the scoping of the runtime lens parent-side FK machinery (cascade walker, RESTRICT pre-check, divergent-basis-FK suppression) so it fires ONLY for lens-routed writes, via a plan-time `lensRouted` marker on `DmlExecutorNode`. Basis-direct DML now bears solely physical (basis-declared) FK semantics — consistent with the plan-time lens RESTRICT collector and logical CHECK.
files: packages/quereus/src/runtime/foreign-key-actions.ts, packages/quereus/src/runtime/emit/dml-executor.ts, packages/quereus/src/planner/nodes/dml-executor-node.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/src/planner/building/insert.ts, packages/quereus/src/planner/building/update.ts, packages/quereus/src/planner/building/delete.ts, packages/quereus/test/lens-enforcement.spec.ts, docs/lens.md
----

## What was implemented

A plan-time `lensRouted: boolean` marker on `DmlExecutorNode` distinguishes the basis-table
spine of a write *routed through a lens view* from a basis-direct write. The runtime
parent-side **logical** FK machinery now fires only when `lensRouted === true`:

1. **Cascade walker** (`executeLensForeignKeyActions`, site 1) — fired from
   `executeForeignKeyActionsAndLens` only when `lensRouted`.
2. **Lens RESTRICT pre-check** (`assertLensRestrictsForParentMutation`, site 2) — step 1b of
   `assertTransitiveRestrictsForParentMutation`, gated on `lensRouted`.
3. **Divergent-basis-FK suppression** (`basisFksOverriddenByDivergentLensFk`, site 3) —
   computed (else empty set) only when `lensRouted`, at all three call sites
   (`executeForeignKeyActions`, `assertNoRestrictedChildrenForParentMutation`, and step 2 of
   the transitive walk).

This makes the runtime side consistent with the already-lens-scoped plan-time lens RESTRICT
collector and the logical CHECK collector. **The headline gap closed:** a basis-direct
`delete from y.parent` no longer fires the logical cascade; and the **soundness hole** in
site 3 is closed — a basis-direct write no longer suppresses its physical basis FK into a
no-op (the suppression set is empty when not lens-routed, so the physical action runs).

### Plumbing (Phase 1)
- `DmlExecutorNode`: new trailing `lensRouted = false` ctor param; carried in `withChildren`
  (regression-asserted); surfaced in `getLogicalAttributes` (conditionally, only when true,
  to avoid plan-dump churn on the common path).
- `buildInsertStmt` / `buildUpdateStmt` / `buildDeleteStmt`: new trailing `lensRouted = false`
  param threaded into every `new DmlExecutorNode(...)` (insert: 1 site; **update: 2 sites** —
  the RETURNING and non-RETURNING paths, which differ in indentation, watch for this; delete:
  1 site).
- `buildViewMutation`: computes `isLensWrite = !!ctx.schemaManager.getSchema(view.schemaName)
  ?.getLensSlot(view.name)` (the exact predicate the lens collectors use) and threads it
  through `buildBaseOp` into the single-source-spine builders. The multi-source /
  decomposition insert builders intentionally leave it `false` (documented in code) — those
  parents resolve to no single basis spine, so the parent-side reverse-map never matches them.

### Runtime gating (Phase 2)
- `emitDmlExecutor` passes `plan.lensRouted` to all insert/update/delete FK call sites; the two
  `processEvictions` calls keep the `false` default (an internal REPLACE eviction is a physical
  basis effect, not a write through the lens).

## ⚠️ Deliberate deviation from the ticket's design — REVIEW THIS CLOSELY

The ticket's design said the **nested transitive recursion** in
`assertTransitiveRestrictsForParentMutation` should pass `lensRouted = false`. **It does not —
it carries the same `lensRouted` value unchanged.** The ticket's stated rationale ("nested
levels are physical-cascade/basis-direct, so pass false") is wrong, and an existing soundness
test proves it:

> `lens enforcement: parent-side FK RESTRICT over a non-restrict basis (runtime pre-check)` →
> "transitive — a lens RESTRICT two hops down (through a basis cascade) ABORTs the top-level
> parent delete" (from the prior landed ticket `lens-parent-side-fk-cascade-basis-restrict-
> lens-runtime-precheck`).

Scenario: `parent → mid → leaf`, where `mid→parent` is an **agreeing** basis+logical cascade
(so the lens cascade is *elided* and the physical basis cascade governs) and `leaf→mid` is a
logical RESTRICT over a basis cascade. Deleting `x.parent` (lens-routed) makes the basis
cascade delete `mid` as a **basis-direct** write at runtime — which (correctly, post-fix) does
NOT fire the `leaf→mid` lens RESTRICT — and the agreeing lens cascade never re-enters through
the child view. So the **only** enforcer of that deeper RESTRICT is the top-level pre-walk
recursing into `mid` with `lensRouted` still `true`. Passing `false` silently drops it (leaf
orphaned). The pre-walk is a pure check (no mutation), so carrying the flag cannot double-act;
and for a basis-direct top write `lensRouted` is already `false`, so the recursion stays
basis-only throughout. The fix matches the pre-change behavior for lens-routed writes while
correctly gating basis-direct writes. Rationale is captured in the function doc-header and at
the recursion site. **Reviewer: confirm this reasoning and the "agreeing basis cascade above a
logical RESTRICT" closure is the right call.**

## Tests added (`test/lens-enforcement.spec.ts`)

New block `lens enforcement: parent-side FK is lens-routed-only (basis-direct DML bears only
basis FKs)` with local `deployCascadeLens` / `deployDivergentLens` / `deployRestrictOverBasis`
helpers (block-local, mirroring the file's existing per-block helper style — the other blocks'
helpers are not in scope here). 8 cases:

- **CASCADE basis-direct gap + lens contrast** — `delete from y.parent` leaves the child;
  `delete from x.parent` cascades it. (headline)
- **CASCADE still fires through the lens** (unchanged-path regression guard).
- **Runtime lens RESTRICT not fired basis-direct** — lens delete ABORTs; `delete from y.parent`
  succeeds and the *basis* CASCADE runs.
- **Divergent-suppression soundness** — logical SET NULL over basis CASCADE: lens delete nulls
  the child; `delete from y.parent` applies the basis CASCADE (NOT a no-op). The site-3 hole.
- **UPDATE cascade variant** and **UPDATE divergent variant** (re-key via `y.parent` vs
  `x.parent`).
- **Transitive smoke** — lens-routed parent delete cascades through a logical grandchild; a
  basis-direct one does not.
- **Plan-node regression** — a lens-routed delete sets `lensRouted`; `getLogicalAttributes`
  surfaces it; `withChildren` preserves it across a rebuild.

## Validation performed

- `npx tsc -p packages/quereus/tsconfig.json` — clean (exit 0).
- Targeted: `lens-enforcement.spec.ts` + `runtime/fk-restrict-runtime.spec.ts` — 145 passing.
- **Full quereus suite** (`node test-runner.mjs`, memory vtab) — **4409 passing, 9 pending,
  0 failing.**
- `eslint` (quereus `lint` script) — clean.

## Known gaps / for the reviewer

- **Not run:** `yarn test:store` (LevelDB store path) and the other workspaces' suites. The
  change is in quereus-internal planner/runtime FK code; the store path exercises a different
  vtab but the same DML-executor wiring. The transitive RESTRICT pre-walk specifically exists
  for rowid-chained backends (lamina) — worth a store-path sanity check that the lens-routed-vs-
  basis-direct distinction holds there too, though no store-specific code was touched.
- **`getLogicalAttributes` surfaces `lensRouted` only when true** (conditional). Intentional to
  avoid churn, but if a reviewer prefers it always-present for EXPLAIN symmetry, that's a 1-line
  change with no behavior impact.
- **Verify the deviation above** is the crux of the review.
- Adversarial angles worth probing: a lens-routed write whose basis spine itself has a *physical*
  FK to a third table (mixed physical+logical at one level); a REPLACE on a lens parent that both
  evicts (physical, `false`) and cascades the displaced row (lens-routed, `plan.lensRouted`) — the
  `processInsertRow` replacedRow site vs the `processEvictions` site use different flags by design.
