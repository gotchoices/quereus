description: Defer full-rebuild MV maintenance to a once-per-statement flush instead of per-row. Adds a per-statement deferred-rebuild set threaded through the maintenance path and an end-of-statement flush hook in the DML executor that drains it as a DAG-ordered worklist. The bounded-delta arms stay per-row-immediate.
prereq: mv-full-rebuild-arm
files: packages/quereus/src/runtime/emit/dml-executor.ts, packages/quereus/src/core/database.ts, packages/quereus/src/core/database-materialized-views.ts, packages/quereus/test/incremental/maintenance-equivalence.spec.ts, packages/quereus/test/logic/53-materialized-views-rowtime.sqllogic, docs/incremental-maintenance.md
----

A full-rebuild re-evaluates the whole body, so running it per source row would be O(rows × body) per statement — pathological. This ticket makes the full-rebuild arm run **once per statement**: source writes mark the MV dirty during the row loop; the dirty set is flushed at the end-of-statement boundary, inside the statement-atomicity savepoint. The bounded-delta arms (`inverse-projection`/`residual-recompute`/`prefix-delete`/`join-residual`) keep applying **per-row immediately** — they are cheap and the covering-UNIQUE enforcement scan depends on per-row visibility. Deferring full-rebuild is safe against that invariant because a full-rebuild MV is **never a covering structure** (`lookupCoveringConflicts` reads only `'inverse-projection'` backings). See `docs/materialized-views.md` § Synchronous, transactional, per-statement (the "Full-rebuild is the one deferred arm" paragraph).

**Threading.** `maintainRowTime` gains an optional `deferred?: Set<string>` (MV keys). When a plan is `'full-rebuild'` and `deferred` is provided, add the MV key and `continue` (no per-row apply). `Database._maintainRowTimeCoveringStructures` threads `deferred` through; add `Database._flushDeferredRebuilds(deferred, connCache)`.

**Hook.** In `dml-executor.ts`, create a `deferredRebuilds = new Set<string>()` once per statement alongside each `backingConnCache` (the INSERT/UPDATE/DELETE runners), thread it through `maintainRowTimeStructures`, and call `_flushDeferredRebuilds` at the end-of-statement point in `runWithStatementSavepoints` — **after** the row loop and **before** the statement savepoint release, so a failed rebuild rolls the statement back.

**Flush = worklist drain.** `_flushDeferredRebuilds` pops keys, calls `applyFullRebuild`, and cascades each rebuilt producer's `BackingRowChange[]` back through `maintainRowTime(backingBase, change, connCache, deferred)`: a full-rebuild consumer re-dirties into the same drain; an incremental consumer applies inline. The DAG is acyclic (a consumer MV requires its producer to pre-exist), so reuse the `assertCascadeDepth`-style guard (bounded by the registered-row-time-MV count) to backstop termination.

## Edge cases & interactions
- **Bulk write**: N rows touching one full-rebuild MV ⇒ exactly **one** rebuild at flush, not N. Assert (e.g. via a row-count/instrumentation check or behavioral equivalence on a multi-row statement).
- **Rollback atomicity**: a statement that fails after dirtying an MV (constraint error, `OR ROLLBACK`, explicit `ROLLBACK`) must leave the backing unchanged — the flush runs inside the statement savepoint, so the rebuild's pending writes revert. Test with a failing multi-row statement.
- **Autocommit**: a bare `insert into T` must flush + commit the rebuild together with the source write (no orphaned pending backing layer).
- **Mixed MVs on one source**: a source with both an incremental MV and a full-rebuild MV — incremental applies per-row during the loop; full-rebuild once at flush. Both end consistent.
- **MV-over-MV with mixed arms**: a full-rebuild producer feeding an incremental consumer (and vice-versa). The producer's flush emits the delta that drives the consumer; an incremental consumer reading a deferred producer sees no producer change during the loop, only at flush — confirm convergence (equivalence harness with a 2-level chain).
- **Reads-own-writes at flush**: the rebuild at flush must see *all* the statement's source writes (the row loop already applied them to the source pending layer). Confirm ordering (flush strictly after the loop).
- **Cold callers**: the enforcement/eviction paths that call maintenance without a `deferred` set must never encounter a full-rebuild plan (full-rebuild MVs aren't covering structures); if reached, applying inline is a safe fallback.
- **Empty dirty set**: flush is a no-op (no overhead on statements that touch no full-rebuild MV).

## TODO
- Add `deferred?: Set<string>` to `maintainRowTime`; defer `'full-rebuild'` plans into it.
- Add `Database._flushDeferredRebuilds`; thread `deferred` through `_maintainRowTimeCoveringStructures`.
- Create the per-statement `deferredRebuilds` set in the DML executor runners; thread through `maintainRowTimeStructures`; call the flush at the end-of-statement savepoint boundary.
- Implement the worklist drain with the depth backstop.
- Tests: one-rebuild-per-bulk-statement; rollback leaves backing unchanged; autocommit flush+commit; mixed-arm same-source; 2-level MV-over-MV mixed-arm equivalence. Add the relevant cases to §53 sqllogic.
- Update `docs/incremental-maintenance.md` (flush boundary + worklist).
