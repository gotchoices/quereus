description: Flip materialized-view eligibility from reject-on-shape to cost-gated-with-floor — no body is rejected for its shape; shape mismatches fall through the arm builders to the always-correct full-rebuild floor. Four non-shape create rejects remain (non-determinism, bag/no-key, no-output, size) plus the new configurable `materialized_view_rebuild_row_threshold`. A soundness guard keeps a deferred floor MV from ever serving as a covering structure for synchronous UNIQUE enforcement. Reviewed and completed.
files: packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/core/database-options.ts, packages/quereus/src/core/database.ts, packages/quereus/src/planner/cost/index.ts, packages/quereus/test/materialized-view-diagnostics.spec.ts, packages/quereus/test/incremental/maintenance-cost.spec.ts, packages/quereus/test/covering-structure.spec.ts, packages/quereus/test/logic/53-materialized-views-rowtime.sqllogic, docs/incremental-maintenance.md, docs/materialized-views.md
----

## What landed

The model flip from `docs/materialized-views.md` § Maintenance strategy: **no MV body is rejected for its shape.** The work spanned two commits — `e85e50f1` (interrupted run; the 721-line `database-materialized-views.ts` reorg + option/cost/spec changes) and `99ed9014` (resume run; the covering-structure guard, doc updates, §26 sqllogic).

- **Builders fall through, not reject.** `buildMaintenancePlan` → `tryBuildBoundedDeltaArm` (returns `null` when no bounded-delta arm matches) → `buildFullRebuildPlan` (the always-correct floor). Each arm builder returns `null` on a *structural* mismatch; the only **hard reject** kept inside an arm is **non-determinism** (so the arm-specific diagnostic survives instead of falling through to the floor's generic one).
- **Four non-shape create rejects** (in `buildFullRebuildPlan`, except per-arm determinism): non-deterministic body, **bag** (`keysOf(root).length === 0`), no relational output, and **size**.
- **Configurable size threshold.** New `materialized_view_rebuild_row_threshold` number option (default `MAINTENANCE_REBUILD_ROW_THRESHOLD` = 10 000; `pragma … = N`; `0` disables). Registered in `Database.setupOptionListeners` with set-time non-negative-finite validation. `isFullRebuildPathological(stats, threshold)` takes the threshold; `buildFullRebuildPlan` gates on the **largest** participating source (re-resolved live via `liveSourceSchema` + `StatsProvider.tableRows`).
- **Covering-structure soundness guard.** `findRowTimeCoveringStructure` skips any plan whose `chosenStrategy === 'full-rebuild'`: a deferred floor MV's backing lags the source mid-statement, so it can never answer a synchronous per-row UNIQUE probe. Both enforcement consumers (`vtab/memory/layer/manager.ts`, `schema/lens-prover.ts`) funnel through `_findRowTimeCoveringStructure`, so the guard is the single authoritative gate.

## Review findings

Reviewed the combined implement diff (commits `e85e50f1` + `99ed9014`) with fresh eyes, then the handoff. Scrutinized for soundness, fall-through correctness, the enforcement gate, type safety, and doc accuracy.

**Checked & verified sound (no action):**
- **Fall-through architecture.** Enumerated every `return null` / `cannotMaterialize` site in `database-materialized-views.ts`: all shape mismatches are `null` fall-throughs; the only hard rejects are the three per-arm determinism throws (inverse-projection 1001, join 1331, TVF 1831) plus the floor's four non-shape rejects (no-output 1416, bag 1424, determinism 1435, size 1481). Determinism cannot double-report: a fanning/non-1:1 join `return null`s at the `proof.ok` check (1316) *before* the join arm's determinism throw, so it lands on the floor's generic determinism reject — a non-determinism reason either way, never a shape reject.
- **Threshold plumbing.** `isFullRebuildPathological` has exactly one production caller (1479), which passes the threshold; `threshold <= 0` short-circuits to "accept any size". `liveSourceSchema` re-resolves the post-`analyze` catalog entry so the size gate reads live counts. `getNumberOption` is type-guarded.
- **Enforcement gate.** Grepped every consumer of `coveringStructureName` / `_findRowTimeCoveringStructure` / `.covers`: the two enforcement paths both route through the guarded resolver; `coveringStructureName` is otherwise read only inside the resolver (overridden by the strategy skip) and by the informational introspection stamp. Each bounded-delta arm asserts its own non-`full-rebuild` `chosenStrategy` (internal error otherwise), so the guard at 2128 matches *only* the floor — no false-skip of a legitimate inverse-projection covering MV. The passing `covering-structure.spec.ts` "row-time covering enforcement" block (per-row MVs still enforce) plus the rewritten join-floor test (floor MV skipped) cover both directions, so no test gap to fill.
- **Tests** (the implementer's, treated as a starting point): the diagnostics spec covers accept-cases (shapes that used to shape-reject now create), reject-cases (the four non-shape reasons with distinctive tails), the size reject + `0`-disable, largest-source gating, pragma round-trip, and invalid-value set-time rejection. §53 §7 flips + §26 (floor maintenance under SQL insert/update/delete on a 2-source UNION) are green. Coverage spans happy path, edge cases (largest-of-N source, threshold disable), and error paths (invalid value, the four rejects). Adequate; I found nothing un-pinned that a focused test would meaningfully add — the deeper rollback/mixed-arm equivalence is white-box in `maintenance-equivalence.spec.ts` by design.

**Minor — fixed inline this pass:**
- **`docs/materialized-views.md` § Enforcement was stale.** It described `_findRowTimeCoveringStructure` as gated only on `stale`, and asserted "a covering materialized view's backing table is maintained synchronously" — both untrue once a covering-shaped body can fall to the deferred floor. Updated the prose to state that only a per-row (bounded-delta) covering MV is eligible and that a deferred `'full-rebuild'` plan is skipped (auto-index answers). (`docs/incremental-maintenance.md`, which carries the detailed guard description, was already updated by the implementer; the §53/diagnostics positive substrings still match.) Note: the coverage-prover's "rejected as *shape*" wording at materialized-views.md:415 is **not** stale — there it correctly means *NotCovers* (the MV still creates), not a create reject.

**Major — already filed by the implementer; framing confirmed adequate (no escalation):**
- **Fanning-join `isSet` over-claim** → `tickets/fix/4-join-fanning-isset-overclaim.md`. `buildJoinRelationType` (`join-utils.ts`) derives an inner/cross join's `isSet` from `leftType.isSet && rightType.isSet` without proving row-preservation, so a fanning join is over-claimed a set; `keysOf` hands it an all-columns key and the floor accepts it, silently collapsing duplicates the backing key cannot hold (`MV → [{id:1,v:5}]` vs `view → [{id:1,v:5},{id:1,v:5}]`). Exposed (not caused) by this flip. The fix ticket is thorough — root cause, confirmed repro, the full `isSet`/`keysOf` blast radius (distinct-elimination, order-by/group-by FD rules, the MV floor), the expected bag-reject outcome, and the wiring into ticket 6 (the fanning case moves to the diagnostics reject spec, not the equivalence zoo). Correctly **not** asserted in §53 §7. I confirm the disposition; no re-framing needed.

**Acknowledged known gaps (documented, no action — folded into downstream tickets):**
- Informational covering link (`mv.covers` / `uc.coveringStructureName`) is still stamped eagerly for floor MVs; enforcement is sound (the strategy skip is authoritative), only the introspective link is inaccurate. Folded into ticket 6's introspection/doc sweep.
- `yarn test:store` not run (reserved for store-specific work); mandated green by downstream ticket 6. The enforcement guard lives in the shared `Database` method, so the memory and store paths share it.
- Size gate over an un-analyzed source falls back to `DEFAULT_SOURCE_ROWS` (1000); behavior for a genuinely large but un-analyzed source at create is not separately pinned (inherent to stats-based gating).

## Validation performed

- `yarn workspace @quereus/quereus run typecheck` — clean.
- `yarn lint` (quereus) — clean.
- Targeted specs (`materialized-view-diagnostics` + `incremental/maintenance-cost` + `covering-structure`): **126 passing, 0 failing.**
- `53-materialized-views-rowtime.sqllogic` (incl. §7 flip + §26 floor-under-SQL-writes): green.
- Doc-only edit to `materialized-views.md` (no test impact).

## Downstream / relationships

- Prereq `mv-statement-flush-deferral` landed; its deferred-flush is now SQL-reachable and exercised end-to-end by §26.
- Ticket 5 (`mv-join-where-widening`) and ticket 6 (`mv-comprehensive-coverage-net`) build on this.
- Fix `4-join-fanning-isset-overclaim` blocks ticket 6's fanning-join equivalence case (wired as a prereq + annotated in ticket 6).
