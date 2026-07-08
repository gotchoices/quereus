description: Phase 2 of splitting the oversized materialized-views engine file finished — the plan-builder and delta-apply method groups now live in their own sibling files, with no behavior change.
files:
  - packages/quereus/src/core/database-materialized-views.ts (2812 → 1112 lines — the manager class)
  - packages/quereus/src/core/database-materialized-views-plan-builders.ts (NEW, 1137 lines — cluster A)
  - packages/quereus/src/core/database-materialized-views-apply.ts (NEW, 647 lines — cluster B)
  - packages/quereus/src/core/database-materialized-views-plans.ts (phase-1 types, untouched)
  - packages/quereus/src/core/database-materialized-views-analysis.ts (phase-1 helpers, untouched)
  - packages/quereus/test/incremental/maintenance-equivalence.spec.ts (white-box test call sites updated)
difficulty: medium
----

## What landed

Phase 2 of the two-phase decomposition of `core/database-materialized-views.ts`. Phase 1
extracted the type layer (`-plans.ts`) and the stateless helper layer (`-analysis.ts`) but
left the whole `MaterializedViewManager` class (2,812 lines) intact. Phase 2 moves the two
large method clusters out of the class as **free functions** taking
`ctx: MaterializedViewManagerContext` as their first parameter.

Result: the manager class shrank **2,812 → 1,112 lines** — comparable to the largest sibling
(`database-events.ts`, 869). Two new files:

- **`-plan-builders.ts` (cluster A, 1,137 lines)** — the cost-gated builder
  (`buildMaintenancePlan`) plus every arm builder (`tryBuildBoundedDeltaArm`,
  `buildInverseProjectionPlan`, `buildAggregateResidualPlan`, `buildJoinResidualPlan`,
  `compileLookupMembershipResidual`, `buildFullRebuildPlan`, `compileResidual`,
  `buildLateralTvfPrefixDeletePlan`) and the shared `liveSourceSchema` /
  `estimateMaintenanceStats`. `DEFAULT_SOURCE_ROWS` moved here too.
- **`-apply.ts` (cluster B, 647 lines)** — the per-arm appliers (`applyInverseProjection`,
  `applyForwardResidual`, `applyJoinResidual`, `applyLookupResidual`, `applyPrefixDelete`),
  the residual runners (`runResidual`, `runScheduler`), the backing-host / connection
  resolvers (`backingHost`, `getBackingConnection`), the derived-row and parent-side
  referential enforcers (`validateDerivedChanges`, `enforceParentSideReferentialActions`),
  and the pure key-compare helpers.

The conversion is mechanical: `this.ctx` → `ctx`, and each intra-cluster `this.foo(...)` →
`foo(ctx, ...)`. It was applied by a **deterministic extraction script** (byte-faithful
dedent + regex seam rewrite, asserting zero surviving `this.`), so every moved body is
verbatim except the seam — not hand-transcribed. The script was removed after use.

## Deviations from the ticket's move-list (READ THIS)

The ticket put `applyMaintenancePlan`, `applyFullRebuild`, and `buildFullRebuildPlan` in the
move lists. The implementation diverged on the first two, because the test suite couples to
them as **instance methods** and the ticket author did not account for that:

1. **`applyMaintenancePlan` (the dispatch switch) and `applyFullRebuild` were KEPT on the
   class.** `test/incremental/maintenance-equivalence.spec.ts` monkeypatches
   `mgr.applyMaintenancePlan` (to observe the effective backing changes each apply realizes —
   the no-op-suppression suite) and `mgr.applyFullRebuild` (to count rebuilds — the
   per-statement-flush-deferral suite). ESM import bindings can't be intercepted, so moving
   these to free functions would silently break those spies. They now stay on the manager as
   its dispatch/flush seam and **delegate** the heavy per-arm work to the free functions in
   `-apply.ts`. Their doc comments note this. Production still calls them via `this.` so the
   spies work. This is the reason the class is 1,112 lines rather than the ticket's ~1,700
   estimate for "cluster A only" — cluster B minus these two dispatch methods still moved.

2. **`buildFullRebuildPlan` moved out cleanly** (its only production caller is the free
   `buildMaintenancePlan`; there is no production `this.`-call). Five test sites called
   `mgr.buildFullRebuildPlan` directly; they were rewritten to call the free function through
   a `buildFloorPlan(db, mv, analyzed)` helper. `db` is passed as the context because
   `new MaterializedViewManager(this)` in `database.ts` makes `ctx === Database`.

3. **Three pure helpers stay pure.** `backingPkEqual`, `residualRowMatchesKey`,
   `residualRowMatchesBasePrefix` never touch `ctx`, so they were extracted as pure free
   functions (no `ctx` first param) rather than mechanically given a spurious one.

## Validation performed

- `yarn workspace @quereus/quereus run build` — pass.
- `yarn workspace @quereus/quereus run lint` — pass (eslint + `tsc -p tsconfig.test.json`,
  which type-checks the spec call sites too — this is what caught / cleared the test-side
  coupling).
- `yarn test` — **6479 passing, 9 pending, 0 failing** (quereus package), all other
  workspaces green. Identical to the phase-1 baseline.

## Where to focus review (tests are a floor, not a ceiling)

The risk in this phase is a **missed `this.` seam** — it compiles fine (the free function
just closes over the wrong thing or mis-binds an arg) and only surfaces at runtime, so the
test suite is the net rather than the type checker. Highest-value checks:

- **Per-moved-method diff.** For a sample of moved methods, diff the new-file body against
  the original (`git show HEAD:.../database-materialized-views.ts`) and confirm the ONLY
  changes are `this.ctx`→`ctx` and `this.foo(...)`→`foo(ctx, ...)` — no logic, constant, or
  argument-order change. The interleaved arms (`buildJoinResidualPlan`,
  `buildLateralTvfPrefixDeletePlan`, `applyPrefixDelete`, `applyLookupResidual`) carry the
  longest soundness comments and the most intra-cluster calls, so they are the most likely
  place for a seam slip.
- **The two retained dispatch methods** (`applyMaintenancePlan`, `applyFullRebuild` in the
  manager): confirm the per-arm calls became `applyInverseProjection(this.ctx, …)` etc. and
  that `applyMaintenancePlan`'s `'full-rebuild'` case still calls `this.applyFullRebuild`
  (so the rebuild-count spy also catches dispatch-path rebuilds).
- **Cross-file call graph.** Clusters A and B are independent (neither calls the other) — the
  builders module imports nothing from the apply module and vice-versa. The manager imports
  `buildMaintenancePlan` from `-plan-builders.ts` and the per-arm appliers + resolvers from
  `-apply.ts`; `lookupCoveringConflicts` (stayed on the class) calls the free `backingHost` /
  `getBackingConnection`. Confirm no accidental circular import was introduced.
- **Import hygiene.** The manager's import list was pruned to only what the staying methods
  use; the two new files import only what their bodies use. Lint (which includes
  `noUnusedLocals`) already gates this, but a spot check that nothing over-broad was carried
  along is cheap.

## Test coverage that exercises the moved code

The row-time maintenance suites are the oracle and all stay green:
`test/incremental/maintenance-equivalence.spec.ts` (the property harness + the arm-selection,
floor-build-reject, flush-deferral, and no-op-suppression white-box suites),
`test/incremental/maintenance-cost.spec.ts`, `test/vtab/maintenance-prefix-delete.spec.ts`,
`test/runtime/maintained-parent-fk.spec.ts`, `test/external-row-change-ingestion.spec.ts`,
`test/maintained-table-*.spec.ts`, and `test/mv-rename-propagation.spec.ts`.

## Known gaps

- **No docs touched.** This is pure internal file organization with no behavior or public-API
  change; the `docs/materialized-views.md` / `docs/incremental-maintenance.md` prose describes
  behavior, which is unchanged. If the reviewer wants the new file names referenced somewhere,
  that is a doc-only follow-up, not a correctness issue.
- **The retained-on-class dispatch pair is a test-coupling compromise, not a clean line.** If
  a future change wants `applyMaintenancePlan` / `applyFullRebuild` fully in `-apply.ts`, it
  must first re-plumb the two white-box suites to observe effective changes / rebuild counts
  through a channel other than instance-method monkeypatching (there is no such public channel
  today). Recorded here rather than filed as a ticket — it is conditional on that future move.
