description: Review the materialized-view eligibility flip — reject-on-shape → cost-gated-with-floor. No body is rejected for its shape; shape mismatches fall through arm builders to the full-rebuild floor. Only four non-shape create rejects remain (non-determinism, bag/no-key, no-output, size), plus the new configurable `materialized_view_rebuild_row_threshold`. Adds a soundness guard so a deferred floor MV is never used as a covering structure for synchronous UNIQUE enforcement.
files: packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/core/database-options.ts, packages/quereus/src/core/database.ts, packages/quereus/src/planner/cost/index.ts, packages/quereus/test/materialized-view-diagnostics.spec.ts, packages/quereus/test/incremental/maintenance-cost.spec.ts, packages/quereus/test/covering-structure.spec.ts, packages/quereus/test/logic/53-materialized-views-rowtime.sqllogic, docs/incremental-maintenance.md
----

## What landed

The model flip from `docs/materialized-views.md` § Maintenance strategy: **no MV body is rejected for its shape.**

- **Builders fall through, not reject.** `buildMaintenancePlan` → `tryBuildBoundedDeltaArm` (returns `null` when no bounded-delta arm matches) → `buildFullRebuildPlan` (the always-correct floor). Each arm builder (`buildInverseProjectionPlan`, `buildAggregateResidualPlan`, `buildJoinResidualPlan`, `buildLateralTvfPrefixDeletePlan`) returns `null` on a *structural* mismatch; the only **hard reject** kept inside an arm is **non-determinism** (so the arm-specific diagnostic survives instead of falling through to the floor's generic one).
- **Four non-shape create rejects** (all in `buildFullRebuildPlan` except per-arm determinism): non-deterministic body (no `pragma nondeterministic_schema`), **bag** (no provable unique key — `keysOf(root).length === 0`), no relational output, and **size**.
- **Configurable size threshold.** New `materialized_view_rebuild_row_threshold` number option (default `MAINTENANCE_REBUILD_ROW_THRESHOLD` = 10 000; `pragma materialized_view_rebuild_row_threshold = N`; `0` disables). Registered in `Database.setupOptionListeners` with set-time validation (non-negative finite). `isFullRebuildPathological(stats, threshold)` now takes the threshold as a param; `buildFullRebuildPlan` reads it via `db.options.getNumberOption(...)` and gates on the **largest** participating source (re-resolved live via `liveSourceSchema` + `StatsProvider.tableRows`).
- **Covering-structure soundness guard (added this pass — see "Discovered during implement").** `findRowTimeCoveringStructure` now skips any plan whose `chosenStrategy === 'full-rebuild'`: a deferred floor MV's backing lags the source mid-statement, so it can never answer a synchronous per-row UNIQUE probe. Both UNIQUE enforcement (`manager.ts`) and the lens prover funnel through this lookup, so the guard is the single authoritative gate.

## Validation performed (this is a floor, not a ceiling)

- `yarn workspace @quereus/quereus run build` — clean (exit 0).
- **Full `yarn test` (quereus package): 5445 passing, 9 pending, 0 failing.**
- Targeted: `materialized-view-diagnostics.spec.ts` (29) + `incremental/maintenance-cost.spec.ts` (14) = 43 passing.
- `53-materialized-views-rowtime.sqllogic` green, including the rewritten § 7 (shape rejects → acceptances + kept non-shape rejects) and the **new § 26** (full-rebuild floor maintenance under SQL insert/update/delete on a 2-source UNION).
- `covering-structure.spec.ts` — the stale "join body rejected at create" test was rewritten to assert the new accept-and-floor behavior + the enforcement-soundness guard; passes.

## Use cases to exercise

**Shape acceptances (now create + maintain via the floor; § 7 + diagnostics spec):** DISTINCT, scalar aggregate (no GROUP BY), 2-table UNION, WHERE-subquery over a second table, LIMIT/OFFSET, correlated-subquery projection, order-by aggregate, lateral-TVF-with-order-by, 1:1 FK join **with** a WHERE, 1:1 **outer** (left) join, MV-over-MV over a floor producer.

**Kept rejects (must still error at create with their non-shape diagnostic):** non-deterministic projection / group / aggregate / TVF (arm-specific tails); bag bodies (PK-dropping projection, recursive `union all`, keyless lateral TVF — the floor's `keysOf` reject); no relational output; size (full-rebuild-only body over a source past the threshold).

**Threshold option:** pragma roundtrip; `= 0` disables (a previously-rejected body then creates); invalid (negative/non-numeric) value rejected at set time; **largest-source** gating (a small driving table joined to a huge lookup gates on the lookup) — all in the diagnostics spec via `analyze`-seeded stats.

**Covering-structure enforcement:** a floor-maintained join MV that the coverage prover admits is **registered** but is **not** an enforcing covering structure (`_findRowTimeCoveringStructure` returns undefined) — UNIQUE enforcement falls back to the auto-index.

## Known gaps / honest flags (treat my tests as a starting point)

1. **Fanning-join `isSet` over-claim (real soundness bug, filed).** `buildJoinRelationType` (`join-utils.ts`) marks an inner/cross join `isSet` from `leftType.isSet && rightType.isSet` without proving the join is row-preserving. A **fanning** (non-1:1) join of two sets is therefore over-claimed a set, `keysOf` hands it an all-columns key, and the floor **accepts** it — then silently collapses the duplicates the backing key cannot hold, diverging from the plain view (`MV → [{id:1,v:5}]` vs `view → [{id:1,v:5},{id:1,v:5}]`, confirmed). Exposed (not caused) by the flip. Filed as **`tickets/fix/4-join-fanning-isset-overclaim.md`** and deliberately **NOT** asserted in § 7 (a note marks the omission). Once fixed, the fanning join routes to the floor's bag reject. **Reviewer:** confirm the fix ticket's framing is adequate, or escalate.
2. **Informational covering link still set for floor MVs (cosmetic).** The eager `linkCoveredUniqueConstraints` runs *before* the maintenance plan is built, so it still stamps `mv.covers` / `uc.coveringStructureName` for a floor MV. Enforcement is sound (the `findRowTimeCoveringStructure` strategy skip is authoritative), but the introspective link is inaccurate. Left as-is to keep the create/rollback path untouched; folded into ticket 6's introspection/doc sweep. A reviewer may prefer gating the link at its source (needs the post-registration strategy).
3. **Store mode not run.** `yarn test:store` was **not** run (slow; AGENTS.md reserves it for store-specific work). The covering-structure guard touches UNIQUE enforcement, which has a store path, and § 53/§ 26 run in store mode too. Store validation is mandated by downstream ticket 6 (`mv-comprehensive-coverage-net`, "Run yarn test and yarn test:store; both green").
4. **Size reject + no-stats source.** The size gate reads `StatsProvider.tableRows`; an un-analyzed source falls back to `DEFAULT_SOURCE_ROWS`. The diagnostics spec seeds counts via `analyze`; behavior for a genuinely large but un-analyzed source at create is not separately pinned.
5. **No § 27 sqllogic for the threshold.** Intentionally omitted — a stats-dependent size reject in the strict sqllogic harness is fragile; the diagnostics spec covers it robustly with seeded stats. The § 7 comment points there.

## Downstream / relationships

- Prereq `mv-statement-flush-deferral` landed (its deferred-flush is now SQL-reachable and exercised end-to-end by § 26 — previously only white-box).
- Ticket 5 (`mv-join-where-widening`) and ticket 6 (`mv-comprehensive-coverage-net`) build on this.
- Fix `4-join-fanning-isset-overclaim` blocks ticket 6's fanning-join equivalence case (now wired as a prereq + annotated in ticket 6).
