description: Continue shrinking the big materialized-views engine file by moving the plan-build and delta-apply method groups into their own files, matching the sibling files. No behavior change.
files:
  - packages/quereus/src/core/database-materialized-views.ts (2,812 lines — still oversized; the class to thin out)
  - packages/quereus/src/core/database-materialized-views-plans.ts (plan types — created in phase 1)
  - packages/quereus/src/core/database-materialized-views-analysis.ts (stateless plan-tree helpers — created in phase 1)
  - packages/quereus/src/core/database-assertions.ts (sibling: target size/shape)
difficulty: medium
----

## Context — this is phase 2 of a two-phase decomposition

The predecessor ticket `database-materialized-views-decomposition` split
`core/database-materialized-views.ts` (originally 3,655 lines) into three files, all
**pure moves** with the whole test suite green (build + lint + `yarn test`: 6479 passing,
0 failing):

- `database-materialized-views-plans.ts` (393 lines) — the `MaintenancePlan` tagged-union
  arm interfaces, `MaterializedViewManagerContext`, `BackingProjector`,
  `CoarseningWatchColumn`, `BackingConnectionCache`. Type-only.
- `database-materialized-views-analysis.ts` (534 lines) — the ~27 **stateless** plan-tree
  helpers (`collectTableRefs`, `findAggregate`, `containsNodeType`,
  `resolveTransitiveSourceCol`, the collation/determinism/replicability gates, the
  `cannotMaterialize`/`nonReplicable*Error` diagnostics, `compileSourceRowEvaluator`, …)
  plus `mvKey` / `planSourceBases`.
- `database-materialized-views.ts` (2,812 lines) — still holds the whole
  `MaterializedViewManager` class. `BackingConnectionCache` is re-exported from here so
  `database.ts`, `database-external-changes.ts`, and `runtime/emit/dml-executor.ts` keep
  importing it from this path unchanged.

Phase 1 removed the type layer and the utility layer but left the class intact, so the
main file is still ~3.5× the largest sibling (`database-events.ts`, 32 KB). Phase 2
finishes the job by moving the two large **method clusters** out of the class.

## The two clusters to extract (both verified `ctx`-only)

Both clusters were confirmed during phase 1 to touch **only** `this.ctx`, each other, the
`database-materialized-views-analysis.ts` helpers, and module constants — **never** the
manager's instance state (`this.rowTime` / `this.rowTimeBySource` maps, the schema-change
subscription). That is exactly why they are cleanly extractable as free functions taking
`ctx: MaterializedViewManagerContext` as the first parameter. The conversion is mechanical:
`this.ctx` → `ctx`, and each intra-cluster call `this.foo(...)` → `foo(ctx, ...)`.

### Cluster A — plan builders → `database-materialized-views-plan-builders.ts`

Methods (all currently `private` on the class):
`buildMaintenancePlan`, `tryBuildBoundedDeltaArm`, `buildInverseProjectionPlan`,
`buildAggregateResidualPlan`, `buildJoinResidualPlan`, `compileLookupMembershipResidual`,
`buildFullRebuildPlan`, `compileResidual`, `liveSourceSchema`, `estimateMaintenanceStats`,
`buildLateralTvfPrefixDeletePlan`.

- Move `DEFAULT_SOURCE_ROWS` (only these builders read it) into this module.
- The **only** call site of this cluster from the rest of the class is
  `registerMaterializedView` → `this.buildMaintenancePlan(mv)`, which becomes
  `buildMaintenancePlan(this.ctx, mv)`.
- Roughly 1,100 lines; brings the main file to ~1,700.

### Cluster B — delta apply → `database-materialized-views-apply.ts`

Methods:
`applyMaintenancePlan`, `applyInverseProjection`, `applyForwardResidual`,
`applyPrefixDelete`, `applyJoinResidual`, `applyLookupResidual`, `applyFullRebuild`,
`runResidual`, `runScheduler`, `validateDerivedChanges`,
`enforceParentSideReferentialActions`, `backingHost`, `getBackingConnection`,
`backingPkEqual`, `residualRowMatchesKey`, `residualRowMatchesBasePrefix`.

- Call sites from the methods that **stay** in the class (`maintainRowTime`,
  `flushDeferredRebuilds`, `lookupCoveringConflicts`) become free-function calls:
  `this.applyMaintenancePlan(...)` → `applyMaintenancePlan(this.ctx, ...)`,
  `this.applyFullRebuild(...)`, `this.validateDerivedChanges(...)`,
  `this.enforceParentSideReferentialActions(...)`, `this.backingHost(...)`,
  `this.getBackingConnection(...)`.
- `detectAndReportCoarseningCollisions` is telemetry driven from the orchestration methods,
  **not** part of the apply cluster — leave it on the class.
- Roughly 700 lines.

### What must stay on the class (touches instance state)

Constructor, `subscribeToSchemaChanges`, `rebuildConstraintValidatorsFor`,
`emitBackingInvalidation`, `registerMaterializedView`, `unregisterMaterializedView`,
`markMaterializedViewStale`, `dispose`, `releaseRowTime`, `sourceBasesFor`,
`materializedViewRefreshOrder`, `buildCoarseningWatch`,
`detectAndReportCoarseningCollisions`, `hasRowTimePlanFor`, `maintainRowTime`,
`flushDeferredRebuilds`, `assertFlushRounds`, `assertCascadeDepth`,
`findRowTimeCoveringStructure`, `resolveCoveringStructureName`, `lookupCoveringConflicts`,
`tryBuildCoveringPrefix`. These read `this.rowTime` / `this.rowTimeBySource` (or are the
subscription/lifecycle surface), so they remain the manager. After both extractions the
class is ~1,200–1,400 lines. If that is still notably over sibling size, the schema-change
subscription block (`subscribeToSchemaChanges` + `rebuildConstraintValidatorsFor` +
`emitBackingInvalidation`, ~250 lines) and the covering-UNIQUE enforcement block
(`findRowTimeCoveringStructure` + `resolveCoveringStructureName` +
`lookupCoveringConflicts` + `tryBuildCoveringPrefix`, ~250 lines) are the next natural
seams — but stop once the pieces are sibling-comparable rather than over-fragmenting.

## Requirements

- **No behavior change.** Pure code-organization. Build, lint, and full `yarn test` must
  pass identically. Unlike phase 1 (which was a byte-identical body move), this phase
  rewrites `this.` references, so the mechanical `this.ctx`→`ctx` /
  `this.foo(...)`→`foo(ctx, ...)` transform must be applied faithfully — a missed `this.`
  becomes a runtime crash, not a compile error, so lean on the test suite as the net.
- Keep the public surface stable: `MaterializedViewManager` and the re-exported
  `BackingConnectionCache` must still resolve from `database-materialized-views.ts`.
- Preserve every doc comment and `NOTE:` tripwire when moving code — the builder/apply
  methods carry long soundness comments; move them verbatim with their method.
- Follow the phase-1 module-naming convention (`database-materialized-views-<group>.ts`).

## Validation

- `yarn workspace @quereus/quereus run build`
- `yarn workspace @quereus/quereus run lint`
- `yarn test` (materialized-view coverage: the logic suite plus `test/incremental/*`,
  `test/maintained-table-*.spec.ts`, `test/mv-rename-propagation.spec.ts`)

## Notes

- A green diff is `git diff --stat` showing functions moving between files with the
  `this.`→`ctx` rewrite and no other logic change. Use a fresh worktree diff of a moved
  method against its original to confirm only the `this.` seam changed.
- The two clusters are independent — Cluster A and Cluster B can be done in either order or
  in one pass. If splitting across runs, chain with `prereq:` and keep each a pure move.
