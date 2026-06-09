description: Per-statement deferral of full-rebuild MV maintenance — full-rebuild plans are marked dirty per source row and rebuilt once at an end-of-statement flush (inside the statement-atomicity savepoint); bounded-delta arms stay per-row-immediate. Reviewed and completed.
files: packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/core/database.ts, packages/quereus/src/runtime/emit/dml-executor.ts, packages/quereus/test/incremental/maintenance-equivalence.spec.ts, packages/quereus/test/logic/53-materialized-views-rowtime.sqllogic, docs/incremental-maintenance.md, docs/materialized-views.md, docs/runtime.md
----

## What landed

Full-rebuild MV maintenance is **deferred to a once-per-statement flush** rather than run per source row (which would be O(rows × body)). Bounded-delta arms (`inverse-projection` / `residual-recompute` / `prefix-delete` / `join-residual`) stay **per-row-immediate** — the covering-UNIQUE enforcement scan depends on their per-row backing visibility, and deferring full-rebuild is safe against that invariant because a full-rebuild MV is **never a covering structure** (`lookupCoveringConflicts` reads only `'inverse-projection'` backings).

- `maintainRowTime(sourceBase, change, cache?, deferred?, depth=0)` — when a plan is `'full-rebuild'` and a `deferred` set is supplied, the MV key is added to `deferred` and per-row apply is skipped; the cascade threads `deferred` through. Without `deferred` (cold callers) it falls through to an inline rebuild (safe, structurally-unreached fallback).
- `flushDeferredRebuilds(deferred, cache?)` — a **round-based** worklist drain over the producer→consumer DAG: each round snapshots the dirty set, clears it, rebuilds each member via `applyFullRebuild`, and routes the realized `BackingRowChange[]` back through `maintainRowTime` with the same `deferred` set (incremental consumer applies inline; full-rebuild consumer re-dirties into the next round). `assertFlushRounds` caps rounds at `rowTime.size + 1`.
- `Database._maintainRowTimeCoveringStructures` gained an optional `deferred`; `Database._flushDeferredRebuilds` is new. `DatabaseInternal` deliberately still exposes only the two-arg form (cold callers).
- The DML executor (`dml-executor.ts`) creates one `deferredRebuilds = new Set<string>()` per statement, threads it through every `maintainRowTimeStructures` call, and `runWithStatementSavepoints` drains it **after the row loop and before the statement-savepoint release** (inside the inner `try`, so a flush failure routes to the rollback).

## Review findings

**Scope checked:** the implement diff (38a559d0) read first with fresh eyes; then every call site of the four changed methods (`maintainRowTime`, `_maintainRowTimeCoveringStructures`, `flushDeferredRebuilds`, `_flushDeferredRebuilds`) via the code index; the savepoint/flush lifecycle in `runWithStatementSavepoints`; the inline-fallback dispatch in `applyMaintenancePlan`; and all three touched docs against the code.

### Correctness — no bugs found
- **Param-reorder safety.** `deferred?` was inserted *before* `depth` in `maintainRowTime`. Verified every caller: the internal recursion (`…, cache, deferred, depth + 1`), the flush cascade (`…, cache, deferred`), and `database.ts` (`…, cache, deferred`) all pass arguments positionally-correctly; no test or source caller passed `depth` as the 4th positional arg. No silent breakage.
- **Threading completeness.** `deferredRebuilds` is plumbed through `processInsertRow` / `processUpdateRow` / `processDeleteRow` / `processEvictions`, the UPSERT-update and REPLACE-eviction sub-paths, and every `maintainRowTimeStructures` call — all 8 maintenance sites in the executor. None left on the old signature.
- **Flush/savepoint atomicity.** The flush is co-located with the statement-savepoint release inside the same `try`: flush-then-release on success, rollback-then-rethrow on failure. A statement that only *dirtied* an MV before aborting never reaches the flush (the loop throws first) — backing untouched. Confirmed by the rollback test (`rebuilds.count() === 0`, source and backing both equal pre-statement state).
- **Inline-fallback dispatch.** Confirmed `applyMaintenancePlan` routes `'full-rebuild'` → `applyFullRebuild`, so the cold-caller (no-`deferred`) path is correct, just unamortized.
- **Round-bound reasoning.** `assertFlushRounds`' `rowTime.size + 1` bound is sound: each round advances one level of the (acyclic) full-rebuild sub-DAG, whose depth ≤ MV count. The round/snapshot/clear approach also handles diamonds without false-throwing (Set dedup), unlike the pop-loop the ticket originally sketched — a deliberate, correct deviation.

### Tests
- Build clean; eslint clean on the four changed source/test files; full `yarn test` (quereus) **5440 passing / 9 pending / 0 failing** (re-run during review, unchanged from handoff). Focused `maintenance-equivalence.spec.ts` 41 passing; §53 sqllogic green.
- Coverage added by the implementer is solid for SQL-reachable + white-box paths: one-rebuild-per-bulk-statement (instrumented counter `=== 1`), atomic rollback, autocommit flush+commit, mixed-arm same source, and incremental-producer→full-rebuild-consumer.

### Minor — fixed inline this pass
- **`docs/runtime.md`** said the flush runs "(for non-FAIL) before the statement savepoint releases", which could read as *not run in FAIL mode*. The flush in fact runs in FAIL mode too (no statement savepoint to unwind, so a flush failure keeps prior rows). Added a clarifying clause.

### Minor coverage gaps — routed to the existing coverage-net ticket (not fixed here)
These branches are **structurally unreachable via SQL today** (the builder never routes to `buildFullRebuildPlan` until ticket `mv-eligibility-floor-fallthrough` flips eligibility), so they cannot be exercised end-to-end yet and are not worth a white-box-only test. Augmented `tickets/implement/6-mv-comprehensive-coverage-net.md` to name them explicitly so the coverage net picks them up once full-rebuild is reachable:
- **Multi-round drain.** Every current test exercises only a *single* flush round (incremental↔full-rebuild). The round-2+ worklist convergence and the `assertFlushRounds` bound are only driven by a **full-rebuild → full-rebuild** chain (or diamond), which needs a SQL-reachable floor to construct.
- **FAIL-mode + full-rebuild** end-to-end (flush after the loop with no statement savepoint).
- **Cold-caller inline fallback** and **FK-cascade double-rebuild idempotency** remain defensive/structural and are covered by the same future net (a full-rebuild MV is never a covering structure, so the cold path never names one).

### Docs
- `docs/incremental-maintenance.md`, `docs/materialized-views.md`, `docs/runtime.md` all read and verified against the code — accurate and consistent (`materialized-views.md` is the authoritative spec; the others conform). The implementer correctly broadened the doc scope beyond the ticket's `incremental-maintenance.md`-only TODO to fix stale "planned/next-refinement" wording in the other two. One clarification fixed inline (above).

## Disposition
No major findings; no new fix/plan tickets needed. The two real coverage gaps were folded into the already-planned downstream `mv-comprehensive-coverage-net` ticket rather than duplicated. Implementation is correct, well-factored, and documented.
