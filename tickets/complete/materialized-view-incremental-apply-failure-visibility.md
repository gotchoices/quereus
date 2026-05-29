description: Two-tier incremental-MV apply-failure recovery (Tier-1 full-rebuild self-heal → Tier-2 `diverged` read-error), fault-injection seam + tests. Reviewed and completed.
files: packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/core/database.ts, packages/quereus/src/schema/view.ts, packages/quereus/src/planner/building/select.ts, packages/quereus/src/runtime/emit/materialized-view.ts, packages/quereus/test/materialized-view-diagnostics.spec.ts, docs/materialized-views.md
----

> **⚠ Superseded (2026-05-29) — feature removed.** Materialized views are being consolidated to a single **row-time** model by `materialized-view-rowtime-only-consolidation` (plan): the `manual` and `on-commit-incremental` refresh policies and the post-commit divergence / self-heal subsystem are removed. The work archived here is retained as historical record only.

## What shipped

An incremental MV (`refresh = 'on-commit-incremental'`) that fails a maintenance
batch no longer silently serves diverged data. On an apply error the
`MaterializedViewManager` escalates in two tiers:

- **Tier 1 — self-heal.** The catch attempts a full `rebuildBacking` (whole-body
  `collectBodyRows`, a *different* path from the per-binding
  `runResidual`/`applyMaintenance` that failed). Residual-specific / transient
  failures recover invisibly with correct data.
- **Tier 2 — visible divergence.** If the recovery rebuild also throws, the new
  `MaterializedViewSchema.diverged` flag is set. Freshly-planned reads then error
  unconditionally (`select.ts` `buildFrom`, before the `stale` block), naming the
  MV and `refresh materialized view <name>`. The user's commit always stands.

`diverged` is cleared only by a full re-materialization: a successful Tier-1
recovery, a successful `refresh`, or the diverged self-heal **retry** (a later
source-touching commit short-circuits the delta and full-rebuilds). A test-only
`@internal` fault-injection seam (`maintenanceFaultInjector`, installed via
`Database._setMaterializedViewMaintenanceFault`) can throw at the
`'residual'`/`'apply'`/`'rebuild'` phase.

## Validation

- Build: `yarn workspace @quereus/quereus run build` — green.
- Lint: `yarn workspace @quereus/quereus run lint` — clean.
- Tests: `yarn workspace @quereus/quereus test` — **3790 passing, 9 pending**
  (3789 + the apply-phase test added in review).

## Review findings

Reviewed the implement diff (`455db2db`) with fresh eyes against the source,
then the handoff. Aspect-by-aspect:

- **Control flow / correctness** — Sound. The diverged self-heal retry, the
  Tier-1 catch recovery, and the `if (mv.diverged)` clear-on-success in the catch
  all behave correctly; the double-rebuild on a diverged-retry whose first rebuild
  throws is accepted (matches the globalRelations path, correct if wasteful).
  Verified the recovery rebuild reads sources (not the MV) so it never recurses
  into the diverged guard; an MV reading a *diverged* MV correctly cascades.
- **Read-path coverage** — Confirmed `select.ts` `buildFrom` is the **single** MV
  read-resolution path (`find_references` on `getMaterializedView` in
  `planner/`), so the guard covers subqueries/joins/CTEs. Refresh has its own
  statement and is not blocked. Good.
- **Clear-paths / interactions** — `refresh` clears both `stale` and `diverged`;
  a stale+diverged MV errors on diverged first then is cleared by refresh.
  Verified.
- **Type safety / cleanup** — `MaintenanceFaultPhase` exported and used; the
  `@internal` seam is never set in production. No leaks. Clean.

**MAJOR — filed `fix/materialized-view-state-flags-bypass-cached-plans`.**
The headline guarantee ("no silent wrong reads") holds only for **freshly planned**
queries. Empirically verified (throwaway probe, since removed): a prepared
statement planned *before* the MV diverged keeps its cached plan and re-executes
returning the old rows with **no error** — because `diverged` is set on the
post-commit path without emitting a plan-invalidation event, and the build-time
guard never re-runs. The pre-existing `stale` flag has the **identical** bypass
(also verified), so this is an inherited limitation of build-time MV-state checks,
not a regression introduced here. Fix (invalidate dependent plans, or move the
guard to runtime) is non-trivial and spans the statement-cache machinery → new
ticket rather than an inline fix.

**MINOR — fixed inline:**
- *Docs overclaim.* `docs/materialized-views.md` said the Tier-2 path "guarantees
  no silent wrong reads"; softened to "freshly planned" and added a Caveat block
  documenting the cached-prepared-statement bypass + pointer to the fix ticket.
- *Inaccurate comment.* `schema/view.ts` claimed `diverged` is "recomputed at
  runtime" — nothing recomputes it; corrected to "runtime-only, resets to falsy on
  reload (a persisted store that diverged in a prior session loses the flag — same
  as `stale`)". Note the durability gap is the same limitation as `stale` and is
  acceptable for v1.
- *Test gap.* The `'apply'` fault phase was wired but unexercised (handoff invited
  a test). Added "Tier 1 — an apply-write failure (residual succeeded) self-heals
  via full rebuild" pinning that the maintenance-**write** failure (residual having
  succeeded) still self-heals through the separate rebuild path.

**Considered, no action needed:**
- *"Commit always stands" asserted explicitly only in the Tier-2 test.* The other
  tests assert the final MV read reflects the source write, which proves the commit
  stood and propagated. Tier-2 (the only case where the read itself errors) carries
  the explicit source-row assertion. Sufficient.
- *Deviation from plan pseudocode* (diverged retry routes through the shared
  `recoveryRebuild` wrapper rather than a bare `rebuildBacking`). Behaviorally
  equivalent; the shared wrapper is the cleaner choice. Fine.
- *No `getDivergedMaterializedViews()` enumerator.* Intentionally out of scope per
  the plan; the read error is the observable. Fine.
- *Direct reads of the hidden `_mv_<name>` backing table bypass the guard.*
  Not a supported read path.
