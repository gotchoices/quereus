description: Phase 2 of splitting the oversized materialized-views engine file is done and reviewed — the plan-builder and delta-apply method groups now live in their own sibling files, with no behavior change.
files:
  - packages/quereus/src/core/database-materialized-views.ts (2812 → 1112 lines — manager class)
  - packages/quereus/src/core/database-materialized-views-plan-builders.ts (NEW, 1137 lines — cluster A)
  - packages/quereus/src/core/database-materialized-views-apply.ts (NEW, 647 lines — cluster B)
  - packages/quereus/src/core/database-materialized-views-plans.ts (phase-1 types, untouched)
  - packages/quereus/src/core/database-materialized-views-analysis.ts (phase-1 helpers, untouched)
  - packages/quereus/test/incremental/maintenance-equivalence.spec.ts (white-box call sites updated)
difficulty: medium
----

## What landed

Phase 2 of the two-phase decomposition of `core/database-materialized-views.ts`. Two large
method clusters moved out of `MaterializedViewManager` as **free functions** taking
`ctx: MaterializedViewManagerContext` first:

- **`-plan-builders.ts` (cluster A)** — cost-gated `buildMaintenancePlan` + every arm builder,
  `liveSourceSchema` / `estimateMaintenanceStats`, and `DEFAULT_SOURCE_ROWS`.
- **`-apply.ts` (cluster B)** — per-arm appliers, residual runners, backing-host / connection
  resolvers, derived-row + parent-side referential enforcers, pure key-compare helpers.

Conversion mechanical: `this.ctx` → `ctx`, `this.foo(...)` → `foo(ctx, ...)`. Manager shrank
2,812 → 1,112 lines.

Two dispatch methods (`applyMaintenancePlan`, `applyFullRebuild`) stayed on the class because
the white-box test suite monkeypatches them as instance methods (ESM import bindings can't be
spied); they delegate the heavy per-arm work to the free functions. `buildFullRebuildPlan`
moved out; five test sites rewritten to call it through a `buildFloorPlan(db, mv, analyzed)`
helper (`ctx === Database` since `new MaterializedViewManager(this)` in `database.ts`). Three
pure helpers (`backingPkEqual`, `residualRowMatchesKey`, `residualRowMatchesBasePrefix`) stay
pure — no spurious `ctx`.

## Review findings

Adversarial pass over the implement diff (`git show 849431be`), read before the handoff.

**Checked — seam fidelity (the phase's core risk: a missed `this.` that typechecks but
mis-binds at runtime):**
- `grep this.` across both new files → **zero surviving `this.`**. Confirmed.
- Every intra-cluster call in `-apply.ts` diffed against the original: `this.foo(args)` →
  `foo(ctx, args)` with **arg order preserved** (`getBackingConnection(host, key, cache)` →
  `getBackingConnection(ctx, host, key, cache)`, `runResidual`, `runScheduler`,
  `applyForwardResidual`/`applyLookupResidual` dispatch, all faithful). No logic/constant/
  arg-order change.
- `applyJoinResidual` body byte-diffed old↔new — identical but for the seam.
- Pure helpers verified pure at def **and** at all 4 call sites (no `ctx` passed).
- Manager's own free-fn calls (`buildMaintenancePlan`, `backingHost`, `getBackingConnection`,
  `validateDerivedChanges`, `enforceParentSideReferentialActions`) all pass `this.ctx` first,
  args preserved.

**Checked — retained dispatch pair:**
- `applyMaintenancePlan` switch delegates each case to the free applier with `this.ctx`; the
  `'full-rebuild'` case still calls `this.applyFullRebuild` (so the rebuild-count spy catches
  dispatch-path rebuilds). `applyLookupResidual` is not a switch case in the new **or** old
  code — it's reached only via `applyJoinResidual`'s lookup-side branch; call graph preserved.
- Both retained methods carry doc comments explaining the test-instrumentation reason.

**Checked — module structure:**
- Clusters A and B independent — neither imports the other (no circular import). Manager
  imports `buildMaintenancePlan` from A, appliers/resolvers from B. All imports use `.js`.
- `DEFAULT_SOURCE_ROWS` has a single home (plan-builders), referenced only there.
- Phase-1 files (`-plans.ts`, `-analysis.ts`) untouched (diff-stat confirmed).
- Import hygiene gated by lint's `noUnusedLocals`.

**Checked — tests:** `buildFloorPlan(db, ...)` helper correct (`ctx === Database` verified at
`database.ts:160`). No orphaned `mgr.<movedMethod>` call sites remain in the test tree.

**Ran (gating):**
- `yarn workspace @quereus/quereus run build` → pass.
- `yarn workspace @quereus/quereus run lint` (eslint + `tsc -p tsconfig.test.json`) → pass.
- `yarn workspace @quereus/quereus run test` → **6479 passing, 9 pending, 0 failing** — matches
  the phase-1 baseline.

**Docs — checked, none stale.** Only ref to the filename in `docs/` is a historical review
artifact (`docs/review.html`), not behavior prose. Behavior/public API unchanged, so the MV
behavior docs are correct as-is. No doc change warranted.

**Findings: none.** No minor fixes applied (nothing to fix), no major tickets filed (no
defects), no correctness/type-safety/resource/error-handling issues found. Clean mechanical
extraction — the type checker + full row-time maintenance suite are the net, and both are
green.

**Tripwire (conditional, not a ticket):** the retained-on-class dispatch pair
(`applyMaintenancePlan` / `applyFullRebuild`) is a test-coupling compromise — if a future
change wants them fully in `-apply.ts`, it must first re-plumb the two white-box suites to
observe effective changes / rebuild counts through a channel other than instance-method
monkeypatching (none exists today). Already recorded in the retained methods' doc comments at
the exact site; no new comment added.
