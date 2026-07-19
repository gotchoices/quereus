description: Bulk inserts into tables with materialized views are 25-90x slower than they should be, because aggregate-view maintenance recomputes per source row; batch it per statement instead.
files: packages/quereus/src/runtime/emit/dml-executor.ts, packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/core/database-materialized-views-apply.ts, packages/quereus/src/core/database-materialized-views-plans.ts, packages/quereus/src/planner/cost/index.ts, docs/mv-maintenance.md, docs/invariants.md, docs/todo.md, packages/quereus/test/incremental/maintenance-equivalence.spec.ts
difficulty: hard
----
## Problem (verified)

External report (originally `tickets/fix/quereus-mv-maintenance-perf.md`): bulk-loading a table
covered by two aggregate materialized views costs ~50-120x more per row than building the same
MVs one-shot afterward, even with all inserts inside one `BEGIN…COMMIT` with ~100-row multi-value
`INSERT` statements. Reported against `@quereus/plugin-indexeddb`, but **reproduced on the memory
vtab** (N=1000, 40 accounts, 24 periods, 100-row statements, the report's two `GROUP BY` MVs):

| scenario | total | per row |
|---|---|---|
| plain insert, no MV | 76 ms | 0.076 ms |
| same insert with 2 aggregate MVs | 1942 ms | 1.94 ms (~25x) |
| one-shot `CREATE MATERIALIZED VIEW` over the populated table | 22 ms | 0.022 ms (~90x gap) |

Root cause is architectural, not store-latency: the `'residual-recompute'` arm
(`applyForwardResidual` in `database-materialized-views-apply.ts`) runs a **fresh
`Scheduler.run` of the key-filtered residual per source row per MV** (~1 ms fixed cost each on
the memory vtab), plus one `applyMaintenance` round-trip per row. 1000 rows x 2 MVs = ~2000
scheduler invocations to produce 112 backing rows. On a store-backed vtab each invocation adds
awaited storage reads/writes, which is why the reporter saw ~2.9 ms/row/MV.

The code and docs already anticipate this fix:

- `applyForwardResidual` doc comment: "Batching/dedup across a whole statement is an
  affordability optimization deferred with the statement-flush boundary."
- `docs/todo.md` § "Statement-level op-coalescing for the incremental arms" is exactly this item.
- `MaintenancePlanCommon.sourceStats` is retained "so the DML boundary can re-cost residual vs.
  rebuild against the actual changeCardinality".
- `shouldDegradeToRebuild` (`planner/cost/index.ts` ~line 370) is the dormant per-statement
  demotion test; every residual plan already carries a dormant `degradeToRebuild: boolean`.
- The full-rebuild floor is **already** deferred to a once-per-statement flush
  (`deferredRebuilds` set in `dml-executor.ts` -> `_flushDeferredRebuilds`), including the OR
  FAIL drain path and the worklist-rounds MV-over-MV cascade. This ticket extends that exact
  pattern to the residual arms.

## Design

Move the three **residual** arms — `'residual-recompute'`, `'join-residual'` (both directions),
and `'prefix-delete'` — from per-row-immediate apply to **per-statement key-deduped flush**.
`'inverse-projection'` stays per-row-immediate: it is the only arm whose backing is read
mid-statement (covering-UNIQUE enforcement via `lookupCoveringConflicts` — see the
enforcement-visibility invariant in `docs/mv-maintenance.md` § Synchronous, transactional,
per-statement), and its per-row delta is a cheap pure projection anyway. Because enforcement
reads only inverse-projection backings, deferring the residual arms needs **no** buffer-unioning
in `lookupCoveringConflicts` (the hard part the todo entry warned about simply does not arise
under this cut).

Mechanism, mirroring the existing full-rebuild deferral:

1. **Accumulate.** Alongside the per-statement `BackingConnectionCache` and `deferredRebuilds`
   set, the DML generator owns a per-statement batch: per residual-arm MV, a map of affected
   binding keys (deduped on canonical key values — `canonKeyValues` — exactly the dedup
   `applyForwardResidual` already does within one change, extended across the statement's
   changes). `maintainRowTime` on a residual plan records the affected key(s) (OLD ∪ NEW per
   change, per the existing tables in `docs/mv-maintenance.md`) instead of running the residual.
   The reverse (lookup-side) join-residual keys accumulate under their own binding so the flush
   runs the correct residual variant per key.
2. **Flush.** At the existing end-of-statement flush site (inside the statement-atomicity
   savepoint; also on the OR FAIL throw path, mirroring `deferredRebuilds`), drain the batch:
   per MV, run the residual once per distinct affected key against live post-statement state and
   apply the keyed diff exactly as today (upsert recomputed slice / delete emptied key). Batch
   all of one MV's ops into as few `applyMaintenance` calls as possible (the op array already
   supports multiple ops per call). Last-write-wins-against-live-state makes recompute-at-flush
   trivially correct — same argument as the current per-row soundness note, evaluated once
   instead of N times.
3. **Re-cost (degrade to rebuild).** Before running per-key residuals, wire the dormant
   `shouldDegradeToRebuild`: with the statement's actual distinct-key count and
   `plan.sourceStats`, when k residual runs cost more than one full rebuild, run the
   full-rebuild `'replace-all'` diff for that statement instead (stored strategy unchanged;
   stateless per statement). This is what closes the gap for statements touching most groups —
   in the repro, each 100-row statement touches ~100 of 72 buckets, so dedup alone barely helps
   the bucket MV; one rebuild per statement does.
4. **Cascade.** A flushed residual's effective `BackingRowChange[]` routes back through
   `maintainRowTime` with the same statement batch — a residual consumer accumulates its keys
   into the batch, a full-rebuild consumer dirties `deferredRebuilds` — and the flush drains in
   worklist rounds over the acyclic producer->consumer DAG, unified with (or structured like)
   `flushDeferredRebuilds`' existing rounds + `assertFlushRounds` bound.
5. **Cold paths unchanged.** Callers with no statement batch (REPLACE-eviction hook, external
   ingestion per-change seam if not batched) fall through to the current inline per-change
   apply — same pattern full-rebuild uses. `ingestExternalRowChanges` should reuse the batch
   across its change array (it already defers rebuilds); confirm and wire.

### Semantics change (document it)

Residual-arm backing state becomes visible at end-of-statement instead of mid-statement. This
matches the full-rebuild floor's already-shipped semantics, and reads-own-writes **between**
statements in a transaction is unchanged — which is why the reporter's ask ("batch across the
whole BEGIN…COMMIT, apply at commit") is deliberately NOT taken: a `select` from the MV between
statements of one transaction must still see maintained state (the MV is contractually
indistinguishable from the plain view). Statement boundary is the widest sound batching window.

Docs to update: `docs/mv-maintenance.md` § `'residual-recompute'` (the "per-row recompute is
correct without batching" paragraph) and § Synchronous, transactional, per-statement (the
"Full-rebuild is the one deferred arm" paragraph becomes "the residual arms and full-rebuild
defer; inverse-projection alone is per-row-immediate"); `docs/invariants.md` MV-003 (currently
"bounded-delta maintenance applies per row, immediately" — narrows to inverse-projection, and
the enforcement rationale carries over verbatim); `docs/todo.md` § Statement-level op-coalescing
(item lands, minus the never-needed `lookupCoveringConflicts` unioning);
`docs/materialized-views.md` § Maintenance summary sentence.

## Edge cases & interactions

- **Enforcement visibility**: covering-UNIQUE conflict probe must still see every earlier
  same-statement row — guaranteed by keeping `'inverse-projection'` per-row-immediate; add a
  regression test asserting an intra-statement duplicate over a covering `unique(x)` still
  aborts (exists in covering-structure.spec.ts — verify it still passes, don't weaken it).
- **OR FAIL**: no statement savepoint; drain the batch on the throw path before re-raising, as
  `deferredRebuilds` does, so the backing reflects surviving rows.
- **OR IGNORE / OR REPLACE**: a per-row savepoint that reverts a row may leave its key in the
  batch — harmless (flush recomputes from live state; value-identical result is suppressed by
  the host). REPLACE eviction fires the cold per-change path mid-statement for the evicted row;
  since the evicted row's MV is residual-arm, prefer routing the eviction change into the
  statement batch when one is in scope rather than inline apply, for consistency.
- **Key-changing update in one statement**: OLD and NEW group keys both accumulate; a row moved
  a->b->a within one statement converges (recompute from live state; suppression eats no-ops).
- **Emptied group**: delete-without-upsert at flush; dedup must retain the `deleteKey` per
  canonical key as `applyForwardResidual` builds it today.
- **Statement failure**: batch is per-statement state owned by the generator — discarded with
  the savepoint unwind; must not leak keys into the next statement.
- **Statement that writes a source and reads the MV** (e.g. via the read-side aggregate-rollup
  rewrite in a subquery): now sees statement-start backing state, aligned with the full-rebuild
  floor's precedent — note it in docs.
- **MV-over-MV**: producer flush -> consumer accumulation -> next round; rounds bounded
  (`assertFlushRounds` analogue). Test a residual-over-residual chain and a
  residual-producer/full-rebuild-consumer mix in one statement.
- **Derived-row validator** (`derivedRowValidator`) and coarsening-collision telemetry
  (`coarseningWatch`): currently applied per backing change before the cascade — at flush they
  apply to the flushed changes; validation failure must still fail (and roll back) the writing
  statement with the same attribution.
- **Multi-statement transaction visibility**: pin with a test — write statement, then same-txn
  `select` from the MV sees the maintained state, then rollback reverts both.
- **Autocommit single-row write**: the degenerate one-key batch must not regress the
  single-row-latency path (flush of one key == today's one residual run).

## Validation

- Correctness oracle: `test/incremental/maintenance-equivalence.spec.ts` (read(MV) ==
  evaluate(body) after each random mutation and after rollback) must pass unchanged; extend its
  mutation generator with multi-row statements if it only exercises single-row DML.
- Perf: repro script (memory vtab, N=1000, 2 aggregate MVs, 100-row statements) — target is
  bulk-insert-with-MVs within a small factor (~2-3x) of plain insert, vs ~25x today. Consider a
  generous performance sentinel (`test/performance-sentinels.spec.ts`) so the regression class
  is guarded.
- `yarn lint` + `yarn test`; `yarn test:store` recommended once (store host exercises
  `applyMaintenance` batching).

TODO
- Add per-statement residual key batch alongside `deferredRebuilds` in dml-executor; thread
  through `maintainRowTime` for the three residual arms
- Flush at the existing end-of-statement site (success, error-with-savepoint, OR FAIL drain);
  batch ops per `applyMaintenance` call
- Wire `shouldDegradeToRebuild` at flush using actual distinct-key count; run `'replace-all'`
  full-rebuild diff for that statement when cheaper
- Unify cascade drain with `flushDeferredRebuilds` worklist rounds
- Keep `'inverse-projection'` per-row-immediate; verify covering-UNIQUE intra-statement test
- Wire `ingestExternalRowChanges` to batch across its change array
- Preserve derived-row validation + coarsening telemetry at flush
- Update docs: mv-maintenance.md, invariants.md MV-003, todo.md, materialized-views.md
- Tests: multi-row-statement maintenance equivalence, statement/transaction visibility, degrade
  path, MV-over-MV mixed-arm flush, perf sentinel
