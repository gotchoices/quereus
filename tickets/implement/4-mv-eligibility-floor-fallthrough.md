<!-- resume-note -->
RESUME: A prior agent run on this ticket did not complete.
  Prior run: 2026-06-09T07:39:52.230Z (agent: claude)
  Log file: C:\projects\quereus\tickets\.logs\4-mv-eligibility-floor-fallthrough.implement.2026-06-09T07-39-52-230Z.log
Read the log to see what was done. Resume where it left off.
If the prior run hit a timeout or repeated error, be cautious not to rush into the same situation.
<!-- /resume-note -->
description: Flip materialized-view eligibility from reject-on-shape to cost-gated-with-floor — no body is rejected for its shape. Shape mismatches in the arm builders fall through to `buildFullRebuildPlan`; hard rejects (non-determinism, bag/no-key, no output) remain; add the configurable `materialized_view_rebuild_row_threshold` size reject.
prereq: mv-statement-flush-deferral
files: packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/planner/cost/index.ts, packages/quereus/src/core/database.ts, packages/quereus/test/logic/53-materialized-views-rowtime.sqllogic, packages/quereus/test/materialized-view-diagnostics.spec.ts, docs/incremental-maintenance.md
----

Today `buildMaintenancePlan` routes by shape and each arm builder calls `reject(detail)` on a sub-shape mismatch, so an unsupported body errors at create. This ticket implements the model flip described in `docs/materialized-views.md` § Maintenance strategy: **no body is rejected for its shape** — a shape that matches no bounded-delta arm falls through to the full-rebuild floor. Only four create-time rejections remain, none shape-based.

**Builders return null on shape mismatch.** `buildJoinResidualPlan`, `buildAggregateResidualPlan`, `buildLateralTvfPrefixDeletePlan`: convert their *structural* `reject(...)` calls to `return null` (caller falls to the floor). Keep as **hard** rejects only: non-determinism (without `nondeterministic_schema`) and no-relational-output. `buildMaintenancePlan` tries the matching builder; on `null`, calls `buildFullRebuildPlan` (from the full-rebuild-arm ticket).

**Reject taxonomy** (`buildMaintenancePlan` / `buildFullRebuildPlan`), all non-shape:
- **non-deterministic body** without `pragma nondeterministic_schema`;
- **bag / no provable unique key** (handled in `buildFullRebuildPlan` via `keysOf`);
- **no relational output**;
- **size**: `isFullRebuildPathological` — full-rebuild is the only sound strategy **and** the largest source exceeds the threshold.

**Configurable threshold.** Register a `materialized_view_rebuild_row_threshold` option (type `'number'`, default `MAINTENANCE_REBUILD_ROW_THRESHOLD` = 10 000) in `Database.setupOptionListeners` (alongside `default_collation` et al.), reachable via `pragma materialized_view_rebuild_row_threshold = N`. `0` disables the size reject (accept any size). `isFullRebuildPathological` (in `planner/cost/index.ts`) takes the threshold as a parameter; `buildFullRebuildPlan` reads it via `db.options.getNumberOption(...)`. Generalize the pathological check to the **largest** participating source's `tableRows` for multi-source bodies (today it is single-source).

The bounded-delta arms remain preferred by the existing argmin cost gate; full-rebuild is selected exactly when no bounded-delta arm is sound (empty sound set ⇒ floor), so existing eligible shapes are unaffected.

## Edge cases & interactions
- **Diagnostic-spec churn**: most existing create-time *shape* reject assertions in `materialized-view-diagnostics.spec.ts` and §53 must flip to *acceptances* (the MV now creates and maintains via the floor). Update them rather than deleting coverage.
- **Hard rejects still fire**: non-deterministic body, bag body, no-output body must still error at create with their (non-shape) diagnostics — keep/repoint those assertions.
- **Size reject + pragma**: a full-rebuild-only body over a source past the threshold rejects with the threshold-naming diagnostic; the same body after `pragma materialized_view_rebuild_row_threshold = 0` (or a high value) creates. Test both.
- **Threshold reads stats**: `tableRows` comes from the StatsProvider; for an empty/small source the body must be accepted. For multi-source bodies, confirm "largest source" is used (a small driving table joined to a huge lookup should still gate on the huge one).
- **Builder null vs hard reject**: ensure a determinism failure inside a join/aggregate body is a *hard reject*, not a silent fall-through to a (still non-deterministic, therefore also rejected) floor — the diagnostics must remain distinct and not double-report.
- **MV-over-MV body**: a body whose source is another MV's backing still routes correctly (it is a keyed memory table); falling to the floor over a backing source is fine.
- **Option roundtrip**: confirm the pragma sets/reads through the existing options framework and that an invalid (non-numeric/negative) value is rejected at set time.

## TODO
- Convert structural `reject(...)` calls in the three arm builders to `return null`; keep determinism / no-output as hard rejects.
- Route `buildMaintenancePlan` null results to `buildFullRebuildPlan`.
- Register the `materialized_view_rebuild_row_threshold` number option; thread it into `isFullRebuildPathological` (param) and `buildFullRebuildPlan`.
- Generalize `isFullRebuildPathological` / `MaintenanceSourceStats` to the largest of multiple sources.
- Update `materialized-view-diagnostics.spec.ts` and §53: flip shape rejects to acceptances; keep hard rejects; add size-reject + pragma-disable cases.
- Update `docs/incremental-maintenance.md` (strategy selection + threshold).
