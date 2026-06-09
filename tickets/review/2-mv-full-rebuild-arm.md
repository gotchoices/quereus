description: Review the wired `'full-rebuild'` materialized-view maintenance arm — the always-correct floor that re-evaluates a body in full and applies a transactional `replace-all`. Build (`buildFullRebuildPlan`: keysOf-derived key, bag reject, whole-body determinism reject, scheduler compile, multi-source `sourceBases`) + dispatch (`applyFullRebuild`) are implemented and exercised in isolation. The eligibility fall-through that *routes* bodies here, the per-statement deferral, and the size-threshold reject are explicitly deferred to the next ticket.
files: packages/quereus/src/core/database-materialized-views.ts, packages/quereus/test/incremental/maintenance-equivalence.spec.ts, packages/quereus/src/vtab/memory/layer/manager.ts, docs/incremental-maintenance.md, docs/materialized-views.md
----

## What landed

The `'full-rebuild'` arm is now real (it previously threw a loud `INTERNAL` guard in `applyMaintenancePlan`). All changes are in `core/database-materialized-views.ts` (the `replace-all` `MaintenanceOp` it consumes already landed in the prereq `mv-rebuild-replace-all-op`).

**`FullRebuildPlan` (interface).** Extended beyond the common identity fields with:
- `bodyScheduler: Scheduler` — the **whole** optimized body compiled once at registration (no `injectKeyFilter`), with the read-side MV rewrite suppressed (`withSuppressedMaterializedViewRewrite`) so it reads its sources, not the backing it populates.
- `backingPkDefinition` — the backing table's physical PK (the key the `replace-all` diff matches against).
- `sourceBases: string[]` — **every** source the body reads; `planSourceBases` returns this for a full-rebuild plan, so `registerMaterializedView` indexes it under each base and a write to any source triggers a rebuild. `MaintenancePlanCommon.sourceBase` is set to `sourceBases[0]` for parity.

**`buildFullRebuildPlan(mv, analyzed)`.** The fall-through builder:
- optimizes the body once (rewrite suppressed) → derives key, determinism, and the scheduler from the *same* optimized plan;
- **bag reject:** `keysOf(optimizedRoot).length === 0` → reject with the relational *no-provable-unique-key / must-be-a-set* diagnostic (`StatusCode.UNSUPPORTED`). `keysOf` already gates its all-columns fallback on `isSet`, so a non-empty result is a real key (true column key OR all-columns key of a provable set) and an empty result is exactly a bag — the all-columns-vs-bag distinction is handled by `keysOf` itself;
- **determinism reject:** `findNonDeterministic(analyzed)` walks every scalar node; a non-deterministic body hard-rejects unless `pragma nondeterministic_schema` is set;
- collects `sourceBases` from `collectTableRefs(analyzed)` (the pre-physical plan, where sources are bare `TableReferenceNode`s);
- compiles `bodyScheduler`; records `chosenStrategy: 'full-rebuild'` (via `selectMaintenanceStrategy([], …)` — empty sound set ⇒ floor) + cost inputs for substrate parity.

**`applyFullRebuild(plan, cache)` + `runScheduler`.** `runResidual` was refactored to delegate to a new shared `runScheduler(scheduler, params)`; `applyFullRebuild` calls it with `{}` (no params, whole body) against live mid-transaction source state (reads-own-writes, same fresh-strict-`RuntimeContext` path the residual arms use), collects the rows, and applies a single `{ kind: 'replace-all', rows }` op via `getBackingConnection` + `applyMaintenanceToLayer`, returning the effective `BackingRowChange[]` for the cascade. It ignores the specific changed row (the floor rebuilds wholesale).

**Dispatch.** `applyMaintenancePlan`'s `'full-rebuild'` case now calls `applyFullRebuild`; the stubbed-arm `INTERNAL` guard is gone (no stubbed arms remain).

Docs: `docs/incremental-maintenance.md` updated (five arms wired; full-rebuild arm mechanics blockquote). `docs/materialized-views.md` already described the floor (written by the prereq) and is consistent.

## Use cases for validation / what to exercise

The correctness oracle is `test/incremental/maintenance-equivalence.spec.ts`. New suites added:
- **full-rebuild floor, single source** — `select id, a from src`, `… where k > 5`, `select k, count(*), sum(a) … group by k`. Random insert/update/delete + rollback; `read(MV) == evaluate(body)` after each (the `replace-all` keyed diff exercises insert/update/delete/skip).
- **full-rebuild floor, multi-source join** — `select t.id, t.fk, p.name from t join p on t.fk = p.id`. Asserts `plan.sourceBases == ['main.p','main.t']`, then drives **both** `t`- and `p`-side writes (a fast-check property + targeted cases) — proving a write to *either* source fires the rebuild.
- **full-rebuild floor, MV-over-MV cascade** — a full-rebuild **producer** (`mv_base`, swapped) drives a consumer (`mv_over`) through the existing cascade on insert/update/delete (its `replace-all` emits the minimal effective delta).
- **build-time rejects** — calls `buildFullRebuildPlan` directly: bag (`select a from src`) rejects as not-a-set; a DISTINCT set is *not* rejected as a bag; `select id, random()` rejects on determinism by default and is accepted under `pragma nondeterministic_schema`.

`yarn test` (quereus): **5431 passing, 9 pending, 0 failing**. Lint clean on both changed files. `yarn build` clean.

## KNOWN GAPS — read before reviewing (your work is a starting point, my tests a floor)

1. **The arm is NOT reachable from `create materialized view` yet — by ticket design.** `buildMaintenancePlan` is deliberately *unchanged*: it still hard-rejects every full-rebuild-only shape (DISTINCT, set operations, >2-source joins, scalar aggregates, fanning/outer joins) with the existing diagnostics. Wiring the fall-through (the cost-gate eligibility flip that makes the floor the default and removes those rejections) is the **next ticket**, which also owns updating the large rejection-assertion suite in `materialized-view-diagnostics.spec.ts` (§ per-reason tails) + `51/53-materialized-views*.sqllogic`. **Do not treat the surviving create-time rejections as bugs.**

2. **Tests are white-box (the swap helper).** Because a genuinely-full-rebuild-only body cannot get a backing table created today (create rejects it before/at registration), the equivalence suites create an MV over a body that is *also* a bounded-delta shape, then swap its registered plan to a freshly-built full-rebuild plan (`forceFullRebuild` reaches `materializedViewManager` internals: `buildFullRebuildPlan`, `releaseRowTime`, `rowTime`, `rowTimeBySource`). So the arm's **mechanics** (runBody → replace-all → cascade, keysOf bag/det rejects, multi-source indexing) are exercised end-to-end, but a body that *only* the floor can handle (a real `union`, an outer join, a set-op) is **not** run through the full create→maintain path. The build-time-reject tests *do* build floor plans for genuinely-floor-only bodies (a DISTINCT set) directly. **Suggested review probe:** sanity-check a real `union`/`union all`/outer-join body by temporarily routing it to `buildFullRebuildPlan` locally (do not commit) to confirm the keysOf-derived key and `sourceBases` behave on a true set-op/outer-join shape — the suites can't reach those shapes until the eligibility flip lands.

3. **Per-statement deferral NOT done — the arm runs per row.** Every source row-write currently triggers a full body re-evaluation + `replace-all` (correct, just O(rows²)-ish for a bulk statement). The DML-boundary deferred-rebuild set / once-per-statement flush described in `docs/materialized-views.md` § Synchronous, transactional, per-statement is the **next ticket**. No bulk-DML performance is claimed here.

4. **Size-threshold reject deferred.** `isFullRebuildPathological` exists in `planner/cost/index.ts` but is *not* called from `buildFullRebuildPlan`, and `pragma materialized_view_rebuild_row_threshold` is **not registered** as an option (confirmed absent). Per the source ticket's "coordinate so the check lands once," this reject belongs to the eligibility-flip ticket (which routes bodies to the floor — the only context in which it bites). The `buildFullRebuildPlan` doc-comment flags this explicitly.

5. **`sourceStats` representativeness.** For a multi-source body, `estimateMaintenanceStats` is computed over `tableRefs[0].tableSchema` only (parity/record-keeping — not consulted at apply time). The docs say the size threshold keys off the *largest* source; that "largest-source" selection lands with the (deferred) threshold reject. A reviewer may want to confirm this is acceptable as a placeholder.

## Things worth a close look
- **`keysOf` on the optimized root vs. determinism on the analyzed plan.** keysOf runs on the fully-optimized body root (FDs/`isSet` available); the determinism walk runs on the pre-physical `analyzed` plan. Both are believed equivalent for their purpose (optimizer neither invents nor elides non-determinism; FD/isSet facts need the optimized plan). Confirm no shape exists where the analyzed plan hides a non-deterministic node the optimized plan would surface (or vice-versa).
- **`runScheduler` refactor.** `runResidual` now delegates to `runScheduler`; verify the residual arms are byte-unchanged (all residual/join/prefix equivalence suites stay green — they do).
- **Empty-body / all-delete.** A body yielding zero rows produces `replace-all []` → empties the backing. Covered indirectly (mutations empty groups/rows) but no dedicated "body goes empty" assertion for the floor specifically.
