description: Bulk inserts into tables with aggregate materialized views were 25-90x slower than needed because view maintenance recomputed per source row; maintenance is now batched per statement (implemented — needs review).
files: packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/core/database-materialized-views-apply.ts, packages/quereus/src/core/database-materialized-views-plans.ts, packages/quereus/src/core/database-materialized-views-plan-builders.ts, packages/quereus/src/core/database.ts, packages/quereus/src/core/database-external-changes.ts, packages/quereus/src/runtime/emit/dml-executor.ts, packages/quereus/src/runtime/emit/materialized-view-helpers.ts, packages/quereus/test/incremental/maintenance-equivalence.spec.ts, packages/quereus/test/performance-sentinels.spec.ts, docs/mv-maintenance.md, docs/invariants.md, docs/todo.md, docs/materialized-views.md, docs/mv-ingestion.md, docs/mv-constraints.md
difficulty: hard
----
## What was implemented

The three **residual** maintenance arms (`'residual-recompute'`, `'prefix-delete'`,
`'join-residual'`) no longer recompute per source row. Their affected binding keys now
accumulate — deduped on canonical key values — in a per-statement `ResidualKeyBatch`
owned by the DML generator, and each distinct key's residual runs exactly once at the
end-of-statement flush. `'inverse-projection'` stays per-row-immediate (covering-UNIQUE
enforcement reads its backing mid-statement). The existing full-rebuild deferral was
unified into the same flush (`flushDeferredMaintenance`, renamed from
`flushDeferredRebuilds`), which drains both structures in worklist rounds over the
MV-over-MV DAG.

Mechanics, by file:

- `database-materialized-views-plans.ts` — new types `ResidualKeyBatch`,
  `ResidualKeyBatchEntry` (separate `forward` / `lookup` / `prefix` key maps so
  join-residual runs the right variant per key), `ForwardResidualKey`, `PrefixDeleteKey`,
  `ResidualMaintenancePlan` union, `ResidualArmCommon`. The dormant `degradeToRebuild:
  boolean` field was **removed** and replaced by `fullRebuildScheduler?: Scheduler` (the
  actual wiring).
- `database-materialized-views-apply.ts` — each residual applier split into
  `collect*Keys` (key derivation, shared by per-row and batched paths) +
  `compute*Ops` (pure op computation) + the original cold inline `apply*` entry
  (unchanged behavior, now composed from the two). New `accumulateResidualKeys` (routes a
  change into the batch by plan kind and changed source) and `computeResidualBatchOps`
  (concatenates one MV's flush ops so they land in ONE `applyMaintenance` call). New
  shared `resolveBackingApplyTarget` (deduplicates the backing/host/connection
  resolution five appliers each had inline).
- `database-materialized-views.ts` — `maintainRowTime` accumulates residual keys when a
  batch is in scope (cold callers still apply inline per change); the post-apply
  invariant pipeline (coarsening telemetry → NOT-NULL PK guard → derived-row validation →
  parent-side FK → cascade) extracted into `postApplyBackingChanges`, shared verbatim by
  the per-row path and the flush. `flushDeferredMaintenance(deferred, residualBatch,
  cache?)` drains rounds (residuals then rebuilds per round; `assertFlushRounds` bound
  unchanged). New `applyResidualBatch` (the instrumentable flush seam) evaluates
  `shouldDegradeToRebuild(distinctKeys, plan.sourceStats)` first — over the crossover it
  runs the whole-body scheduler and applies one `'replace-all'` diff via the new shared
  `applyReplaceAll` (which `applyFullRebuild` now delegates to). `findRowTimeCoveringStructure`
  now declines every non-`'inverse-projection'` kind (was: only `chosenStrategy ===
  'full-rebuild'`) — the defense-in-depth parity the ticket asked for.
- `database-materialized-views-plan-builders.ts` — residual plans get a whole-body
  scheduler compiled at registration (`compileWholeBodyScheduler`, mirrors the floor's
  `bodyScheduler`); `degradeToRebuild: false` literals removed.
- `dml-executor.ts` — each generator creates `residualBatch` alongside
  `deferredRebuilds`/`backingConnCache` and threads it through every maintenance call
  (including REPLACE evictions via `processEvictions`, so an eviction routes into the
  statement batch as the ticket preferred). Flush at the existing success site and on the
  OR FAIL throw path, condition now `deferred.size > 0 || residualBatch.size > 0`.
- `database.ts` / `database-internal.ts` — `_maintainRowTimeCoveringStructures` gains the
  optional `residualBatch` param; `_flushDeferredRebuilds` renamed
  `_flushDeferredMaintenance(deferred, residualBatch, cache?)`. The internal two-arg cold
  seam is unchanged.
- `database-external-changes.ts` — the ingestion batch creates and flushes a
  `residualBatch` exactly like one DML statement.
- `materialized-view-helpers.ts` — the attach-reconcile cascade batches across its change
  array the same way.

### Semantics change (documented)

Residual-arm backing state is now visible at **end-of-statement**, not mid-statement —
matching the full-rebuild floor's already-shipped semantics. Between-statement
reads-own-writes inside a transaction is unchanged (the flush runs inside the statement
savepoint, before release). Docs updated: `docs/mv-maintenance.md` (§ residual-recompute,
§ cascade reads-own-writes, § Synchronous/transactional/per-statement — the deferred-arm
paragraph now covers both structures + degrade), `docs/invariants.md` (MV-003 narrowed to
inverse-projection, MV-004 broadened to "residual arms and full-rebuild defer"; anchors
updated), `docs/todo.md` (op-coalescing item marked landed; the feared
`lookupCoveringConflicts` buffer-unioning was never needed under this cut),
`docs/materialized-views.md`, `docs/mv-ingestion.md`, `docs/mv-constraints.md`.

## Measured result

Repro from the original report (memory vtab, N=1000, 40 accounts, 24 periods, 100-row
statements, two aggregate MVs): **plain insert 61 ms; with 2 MVs 183 ms — 3.0x** (was
~25x / 1.94 ms per row). Meets the ticket's ~2-3x target. Guarded by a new performance
sentinel (`test/performance-sentinels.spec.ts` § "Materialized-view bulk-insert
maintenance") using a ratio bound (12x) so it is stable across CI hardware.

## Validation run

- `yarn lint` clean (eslint + test-file tsc).
- Full quereus suite: **7096 passing, 0 failing** (`node test-runner.mjs`).
- `yarn test` at repo root (all workspaces): green.
- `yarn test:store` (LevelDB store host — exercises `applyMaintenance` batching through
  the store backing): 7090 passing.
- The covering-UNIQUE intra-statement duplicate test (`covering-structure.spec.ts`,
  "multi-row INSERT with an intra-statement duplicate") passes unchanged — not weakened.

## Tests added / changed

- `maintenance-equivalence.spec.ts`:
  - The shared property mutation generator now emits **multi-row statements**
    (multi-value insert, predicate multi-row update that moves group keys, predicate
    delete) — exercised by the covering-index, aggregate, lateral-TVF, and full-rebuild
    property suites (read(MV) == evaluate(body) in-txn and post-rollback).
  - The no-op-suppression `instrument()` now wraps BOTH apply seams
    (`applyMaintenancePlan` per-row + `applyResidualBatch` flush); all 26 suppression
    assertions pass with unchanged expected op shapes.
  - New suite "Materialized-view maintenance statement batching (residual arms)":
    one flush per statement with statement-wide key dedup (6 rows → 2 distinct keys, no
    per-row dispatch); between-statement visibility + rollback; OR FAIL error-path drain;
    OR IGNORE / OR REPLACE multi-row equivalence; **degrade-to-rebuild** (sourceStats
    pinned deterministically post-registration: k=2 stays per-key, k=4 demotes to exactly
    one replace-all, next single-row statement reverts — stateless); mixed-arm MV-over-MV
    chain (residual producer → inverse-projection consumer + residual-over-residual
    consumer) converging in one statement flush, including emptied-group delete cascade.
- `performance-sentinels.spec.ts`: the bulk-insert-with-MVs ratio sentinel above.
- `maintained-table-attach-detach.spec.ts`: capture wrapper forwards the new
  `residualBatch` arg.

## Known gaps / honest notes for the reviewer

- **Join-residual and prefix-delete batched flush** are covered by their property suites
  (which drive them through the one-key batch every statement) and by the multi-row
  generator for the lateral-TVF shapes — but the **join** suites' own mutation generators
  still emit single-row statements, so a genuinely multi-key join-residual batch (several
  T keys + several P keys accumulated in one statement, e.g. via FK cascade) is exercised
  only indirectly (the mixed-arm chain test drives multi-key forward batches; the
  lookup-side multi-key case has no dedicated test). Adding multi-row mutations to the
  join generators would close this.
- **Degrade demotion is tested only on the aggregate arm.** The same code path serves
  prefix-delete/join-residual (`shouldDegradeToRebuild` costs them identically as
  `'residual-recompute'` — an approximation; a fan-out-aware residual cost would be a
  cost-model refinement, not a correctness issue).
- **OR FAIL + flush-time validation failure**: with no statement savepoint, a
  derived-row-validation or RESTRICT failure raised AT the flush leaves the
  already-applied flush ops in the pending transaction layer while the error propagates.
  This is the full-rebuild floor's pre-existing OR FAIL semantics extended to the
  residual arms — not new in kind, but now reachable from more shapes. The backing
  content itself is correct (recomputed from surviving rows); it is the
  "validation failed but writes remain pending" corner that a reviewer may want to
  scrutinize (the transaction is still open; a subsequent rollback discards everything).
- **Registration cost tripwire** (NOTE comment at the site,
  `database-materialized-views-plan-builders.ts` § `buildMaintenancePlan`): every
  residual-MV (re)registration now compiles one extra whole-body scheduler
  (optimize+emit). Fine now; compile lazily on first degrade if bulk catalog import ever
  makes registration latency matter.
- The nested-statement case (FK cascade DML during an outer statement) creates its own
  per-statement batch and flushes at the nested statement's end — consistent with how
  `deferredRebuilds` already behaved; an outer-statement flush may then recompute the
  same keys again (correct, mildly redundant).

## Review suggestions

- Soundness of the deferral cut: verify no OTHER mid-statement reader of residual/
  full-rebuild backings exists beyond `lookupCoveringConflicts` /
  `findRowTimeCoveringStructure` (the claim the whole design rests on).
- The flush's round ordering (residuals before rebuilds within a round) and the
  `assertFlushRounds` bound under mixed chains.
- `computeResidualBatchOps` op-ordering argument for a join-residual MV with both
  forward and lookup keys in one statement (comment at the function documents the
  same-live-state consistency argument).
- The degrade threshold behavior for small tables under naive stats (a tiny
  `forwardBodyCost` could demote even modest statements — behavior is correct either
  way, but the cost model's calibration was not revisited here).

## Review findings

(to be filled by the review stage)
