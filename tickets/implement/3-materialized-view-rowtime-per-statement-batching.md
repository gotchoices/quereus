description: Batch row-time materialized-view maintenance at the **statement boundary** rather than strictly per source row, amortizing the backing-connection/layer lookup over a whole statement. Reads-own-writes must still hold *between* statements within a transaction. Critically, this must NOT break **within-statement** covering-MV UNIQUE enforcement, which scans the backing table for prior rows of the *same* statement.
prereq: materialized-view-rowtime-only-consolidation
files: packages/quereus/src/runtime/emit/dml-executor.ts, packages/quereus/src/core/database.ts, packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus/test/logic/53-materialized-views-rowtime.sqllogic, packages/quereus/test/logic/54-covering-mv-enforcement.sqllogic, docs/materialized-views.md
----

## Goal

Today `maintainRowTimeStructures` is called **per source row** inside the
DML-executor generators (`runInsert`/`runUpdate`/`runDelete`), each call
re-resolving the backing `MemoryTableConnection`
(`getBackingConnection` → `getConnectionsForTable` scan + lazy registration) and
applying one row's ops. On a bulk statement this pays the lookup N times. The
decision (`materialized-view-rowtime-only-consolidation`) is to **batch per
statement**: amortize the connection/layer resolution over the whole statement.
The docs already describe this ("Deltas are batched per statement … flushes once
at the statement boundary"). Reads-own-writes still holds *between* statements.

## The central constraint (read before designing)

A naive "accumulate all ops, flush once at end of statement" **breaks correctness**
for covering-MV UNIQUE enforcement. Enforcement runs *inside* the source vtab's
`update()` (e.g. `checkUniqueViaMaterializedView` →
`Database._lookupCoveringConflicts`), which **scans the covering MV's backing
table** and relies on it already reflecting *prior rows of the same statement*
(its doc comment: "the backing reflects all prior rows of the statement"). The
maintenance for row N is applied *after* `update()` returns; row N+1's enforcement
scan must see row N. So a backing write cannot be deferred past the next
intra-statement read that could observe it.

Concretely: `insert into t values (1,'a'),(2,'a')` where a row-time MV covers
`unique(x)` — row 2's enforcement must see row 1's backing entry to detect the
duplicate. Full end-of-statement deferral would miss it.

## Resolved approach

Treat "batching" as **amortizing the connection/layer resolution and op
accumulation, while preserving visibility before any dependent read** — not
unconditional end-of-statement deferral:

1. **Cache the backing connection per statement.** Resolve each covering MV's
   backing `MemoryTableConnection` **once** per (statement, backing) and reuse it
   across the statement's rows. This eliminates the per-row
   `getConnectionsForTable` scan + registration — the dominant per-row overhead —
   with zero visibility change. This alone delivers the bulk-DML win the decision
   asked for and is **always safe**.

2. **Keep maintenance visible to the next intra-statement read.** Apply each row's
   ops to the (cached) pending transaction layer immediately, OR accumulate and
   flush *before* the next enforcement scan. The simplest correct realization:
   keep per-row `applyMaintenanceToLayer` but on the cached connection. If true op
   batching is pursued, the covering-enforcement scan
   (`lookupCoveringConflicts`) must union the not-yet-flushed batch buffer, or the
   batch must flush before every enforcement read — do not ship a version where a
   later same-statement row's enforcement can miss an earlier row.

3. **Flush at the statement boundary** for any residual buffered ops (the common
   case where no covering enforcement consumes them mid-statement — e.g. a plain
   non-covering MV over a bulk insert). The pending layer is already committed/
   rolled back in lockstep by the coordinated commit, so the boundary flush needs
   no new transactional plumbing.

Recommendation for v1: implement (1) (connection caching) + per-row apply on the
cached connection. This captures the amortization win with no enforcement risk.
Layer (2)/(3) true op-coalescing on top only if profiling shows the per-row
`recordUpsert`/`recordDelete` is itself hot — and only with the enforcement-buffer
union in place. Document whichever is shipped.

## Where the statement boundary lives

The DML generators are async generators that yield row-by-row; the boundary is the
generator's completion (after the final yield / in a `finally`). The per-statement
connection cache should be scoped to one generator run (e.g. a `Map<backingBase,
MemoryTableConnection>` created at generator entry, passed into
`maintainRowTimeStructures`). Account for the REPLACE-eviction maintenance calls
that also fire from inside the memory/store manager
(`checkUniqueViaMaterializedView`, `store-table.ts`) — those occur mid-`update()`
and must observe/contribute to the same statement's backing state; route them
through the same cached connection (or ensure they resolve the same connection the
batch uses). Autocommit single-statement writes still ride the statement-level
autocommit boundary — source + backing commit together.

Interaction to verify with `dml-executor-statement-savepoint-broadcast` /
`dml-update-delete-statement-atomicity` (statement savepoints): a statement-level
rollback must revert the batch's backing writes in lockstep (it does today,
because the writes live on the same connection's pending layer the statement
savepoint covers — confirm this holds with the cached connection).

## Tests

- `53` / `54`: add a **bulk multi-row** insert/update/delete and assert the backing
  contents are correct (per-statement maintenance) and that a statement/transaction
  rollback reverts the backing fully.
- **Intra-statement enforcement** (the critical case): a covering MV over
  `unique(x)`; `insert into t values (…dup within one statement…)` must detect the
  duplicate (ABORT / IGNORE / REPLACE all resolve correctly), proving the batch
  did not hide an earlier same-statement row from a later row's enforcement scan.
- Reads-own-writes between statements within an explicit transaction still holds.

## Docs

`docs/materialized-views.md` § Maintenance already documents per-statement
batching. Reconcile its wording with what actually ships (especially the
reads-own-writes-*between*-statements clause vs. the within-statement enforcement
guarantee) — make the enforcement-visibility invariant explicit so a future reader
does not "optimize" it into a correctness bug.

## Validation

- Build + lint clean.
- `yarn test` green — stream: `yarn test 2>&1 | tee /tmp/mv-batch.log; tail -n 80 /tmp/mv-batch.log`.
- Recommended once: `yarn test:store` for the store-table covering-enforcement path
  (it shares the maintenance surface). If wall-clock is prohibitive in-agent, defer
  to CI and note it.

## TODO

- Add a per-statement backing-connection cache in the DML generators; thread it
  into `maintainRowTimeStructures` and `maintainRowTime`.
- Ensure REPLACE-eviction maintenance (memory `checkUniqueViaMaterializedView`,
  `store-table.ts`) uses the same cached connection / observes the same state.
- (If pursuing op-coalescing) make `lookupCoveringConflicts` union the pending
  batch buffer, or flush-before-enforcement; otherwise keep per-row apply on the
  cached connection.
- Flush residual buffered ops at generator completion.
- Verify statement-savepoint rollback reverts batched backing writes.
- Tests per above; reconcile docs.
