description: Runtime collision telemetry for coarsened-key materialized views — a host-observable `db.onMaintenanceCollision` event + cumulative `db.getMaterializedViewCollisionStats()` counter, fired from row-time maintenance whenever an upsert under a coarsened backing key K′ LWW-merges two distinct source-key tuples. Pure core-engine surface, rides the existing `DatabaseEventEmitter` transaction batching. Implemented, reviewed, and shipped.
files:
  - packages/quereus/src/core/database-events.ts                  # collision channel: MaintenanceCollisionEvent, collisionListeners/batched/layers, onMaintenanceCollision/hasCollisionListeners, queueCollision/emitCollisionEvent, cumulative collisionCounts, lifecycle participation, getMaterializedViewCollisionStats
  - packages/quereus/src/core/database.ts                         # db.onMaintenanceCollision + db.getMaterializedViewCollisionStats
  - packages/quereus/src/core/database-materialized-views.ts      # CoarseningWatchColumn + coarseningWatch on MaintenancePlanCommon; buildCoarseningWatch; detectAndReportCoarseningCollisions; call sites in maintainRowTime + flushDeferredRebuilds; getEventEmitter() on MaterializedViewManagerContext
  - packages/quereus/src/index.ts                                 # export MaintenanceCollisionEvent
  - packages/quereus/test/mv-coarsening-collision-telemetry.spec.ts  # 11 cases (9 from implement + 2 added in review)
  - docs/materialized-views.md                                    # § Coarsened backing keys — implemented telemetry bullet + accepted-limit correction
  - docs/migration.md                                             # § Convergence hazards (silent → observable)
----

# Complete: MV key-coarsening collision telemetry

## What shipped

The create-time key-coarsening warning says the LWW-merge hazard *exists*; this
work adds the runtime signal that says it is *happening*. When row-time
maintenance upserts under a coarsened backing key K′ and replaces a backing row
whose source identity differs from the incoming row's (two distinct source-key
tuples — `'Bob'`/`'bob'` — collapsing onto one K′ row, LWW), the engine fires a
host-observable `db.onMaintenanceCollision(...)` event and increments a
cumulative per-table counter exposed by `db.getMaterializedViewCollisionStats()`.

- **Collision channel on `DatabaseEventEmitter`** — a third channel parallel to
  the data/schema channels, sharing their exact transaction-batching discipline
  (batched/savepoint-layered; committed-merges-only counter incremented in
  `flushBatch`; dropped on `discardBatch`/savepoint rollback; per-listener
  try/catch isolation).
- **Detection** — `coarseningWatch` precomputed once at registration, `undefined`
  unless `mv.derivation.coarsenedKey` is stamped (the zero-overhead gate for
  non-coarsened MVs). `detectAndReportCoarseningCollisions` compares each
  `'update'` change's weakened K′ columns under the *source* collation; any
  divergence ⇒ queue one event. Wired into both `maintainRowTime` (bounded-delta
  arms) and `flushDeferredRebuilds` (full-rebuild floor). Observe-only — never
  perturbs the cascade.
- **Public API** — `db.onMaintenanceCollision(...)`, `db.getMaterializedViewCollisionStats()`,
  `MaintenanceCollisionEvent` exported from the package root.

## Review findings

Adversarial pass over the implement-stage diff (`3b29ad6c`), read fresh before
the handoff summary, scrutinized from correctness / type-safety / DRY /
resource-cleanup / error-handling / completeness angles.

### Correctness — checked, no defects

- **Type safety.** `BackingRowChange`'s `'update'` variant carries non-optional
  `oldRow: Row` / `newRow: Row`; `detectAndReportCoarseningCollisions` narrows on
  `change.op !== 'update'` before reading them, so the reads are statically sound
  (no non-null assertions). The `MaintenancePlan` dispatch is exhaustive via a
  `never` check.
- **Schema reads.** `CoarsenedKeyInfo.columns` (key-order names) and
  `weakened[].{column,sourceCollation,outputCollation}` match what the watch
  builder and the helper read; `columnIndexMap` is lowercased-keyed and the code
  lowercases every lookup. Verified against `schema/view.ts` and `schema/table.ts`.
- **Divergence criterion.** Comparing old/new weakened-column values under the
  *source* collation is the right test: a genuine 2-row K′ merge necessarily
  differs in ≥1 weakened column under the source collation (non-weakened K′
  columns enforce source=output collation, so they'd be equal), so there are **no
  false negatives** for real merges; a same-source non-key update (e.g. `email`)
  leaves the weakened columns equal and is correctly *not* reported.
- **Call-site completeness.** Confirmed by reference search that the only
  maintenance-apply sites producing a silent coarsened merge are `maintainRowTime`
  (→ `applyMaintenancePlan`) and `flushDeferredRebuilds` (→ `applyFullRebuild`);
  both are instrumented. Full-rebuild's deferred-vs-inline paths are mutually
  exclusive (`deferred` set ⇒ defer to flush; unset ⇒ apply+detect inline), so a
  rebuild is **never double-detected**. The `refresh materialized view` rebuild
  (`materialized-view-helpers.ts`) is intentionally *not* instrumented — it
  rejects duplicate K′ keys loudly (`assertRefreshRowsAreSet`), so it is not a
  silent-merge site. Out-of-scope item #3 in the handoff is accurate.
- **Counter semantics.** Incremented exactly once per committed collision (in
  `flushBatch` for the batched path; immediately on the non-batching path, which
  has no transaction to roll back, so the committed-only guarantee holds either
  way). No double-counting.
- **The "accepted limit" correction.** The implementer correctly discovered the
  plan's original rationale (PK-value updates decompose into delete+insert) was
  wrong — a PK-changing source UPDATE reports as one `{op:'update'}`, so a
  single-source in-place key-case rename *does* fire a false-positive collision.
  Accepting it, pinning it with an `ACCEPTED LIMIT` test, and correcting both docs
  to the true behavior is the right call (the alternative — source-PK provenance
  plumbing — is explicitly out of scope). **Confirmed: accept-and-document is correct.**

### Tests — happy path covered by implement; edge/lifecycle gaps closed in review

The 9 implement-stage cases cover steady-state LWW (inverse-projection),
zero-overhead invariant, same-source non-key update, full-rebuild floor,
multi-column key, the accepted-limit false positive, full-transaction rollback,
ingest seam, and listener-error isolation.

**Added inline (minor — fixed this pass):** the savepoint-layer code (begin /
rollback-to / release) was the one substantive new path with no *dedicated*
coverage (only full-transaction rollback was tested). Added:
- `a savepoint rolled back to drops its collisions while the base collision still commits`
  — exercises `rollbackSavepointLayer` for the collision channel directly.
- `multiple collisions in one transaction each fire and accumulate the counter`
  — pins per-merge event emission + counter accumulation (N>1) within one batch.

Both pass; suite now 11 cases.

### Minor observations (no action — documented here, not filed)

- **Channel lifecycle duplication (DRY).** The data/schema/collision channels now
  carry near-identical batch/savepoint-layer lifecycle code in
  `startBatch`/`flushBatch`/`discardBatch`/`begin|rollback|releaseSavepointLayer`/
  `removeAllListeners`. The collision channel *correctly mirrors* the existing
  pattern; this is pre-existing pattern debt extended by one channel, not new
  debt. Generalizing the three into a channel list is a larger refactor outside
  this ticket's scope — left as a future-cleanup candidate, deliberately **not**
  filed to avoid scope creep.
- **`keyIndices` `?? -1` fallback** in `detectAndReportCoarseningCollisions` is
  silent (unlike `buildCoarseningWatch`, which logs+skips an unresolvable column).
  Defensive-only: a stamped `coarsenedKey` with an unresolvable key column would
  be a derivation bug that cannot occur in practice. Not worth a code change.
- **Counter-map key casing.** The map is keyed by lowercased `schema.table`, but
  the event payload's `schemaName`/`tableName` are the raw plan values — a host
  correlating an event to a stats entry must lowercase the qualified name itself.
  Documented in the JSDoc and `docs/materialized-views.md`. Minor ergonomics, fine.

### Docs — verified against the new reality

Read both touched docs (`materialized-views.md` § Coarsened backing keys,
`migration.md` § Convergence hazards) end-to-end. They accurately describe the
implemented behavior: the host-observable event + counter, the transaction
batching, the zero-overhead-for-non-coarsened guarantee, the observe-only
posture, the accepted heuristic false positive (with the *corrected* rationale),
both-arms-report-identically, and the REFRESH-is-not-a-collision-site fact. The
stale "planned operational complement" / "Current gaps" bullets were removed.

### Major findings: none.

No new fix/plan/backlog tickets filed.

## Validation performed (review)

- `yarn workspace @quereus/quereus test` → **6160 passing, 9 pending, 0 failing**
  (6158 baseline + 2 review-added cases).
- `yarn workspace @quereus/quereus lint` → clean (eslint + `tsc -p tsconfig.test.json`), exit 0.
- Did NOT run `test:store` — detection is host-agnostic (reads the
  `BackingRowChange[]` the host returns; the store host's `applyMaintenance`
  update-reporting shape is already pinned by `quereus-store/test/backing-host.spec.ts`).
  Store parity is a reasonable CI follow-up, not expected to differ.

## Out of scope (per plan; not implemented)

- `remote` flag distinguishing ingest-seam vs local-DML collisions — payload
  field reserved but unset.
- SQL / introspection-TVF surface for the counter (programmatic API only).
- REFRESH-path telemetry — REFRESH rejects duplicate K′ keys loudly, not a silent
  merge site.
