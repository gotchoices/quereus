description: Review — runtime collision telemetry for coarsened-key materialized views. A host-observable `db.onMaintenanceCollision` event + cumulative `db.getMaterializedViewCollisionStats()` counter fired from row-time maintenance whenever an upsert under a coarsened backing key K′ LWW-merges two distinct source-key tuples. Pure core-engine surface, no `@quereus/sync` dependency, rides the existing `DatabaseEventEmitter` transaction batching.
files:
  - packages/quereus/src/core/database-events.ts                  # NEW collision channel: MaintenanceCollisionEvent, collisionListeners/batched/layers, onMaintenanceCollision/hasCollisionListeners, queueCollision/emitCollisionEvent, cumulative collisionCounts, lifecycle participation, getMaterializedViewCollisionStats
  - packages/quereus/src/core/database.ts                         # db.onMaintenanceCollision + db.getMaterializedViewCollisionStats; MaintenanceCollisionEvent import
  - packages/quereus/src/core/database-materialized-views.ts      # CoarseningWatchColumn + coarseningWatch on MaintenancePlanCommon; buildCoarseningWatch (registration); detectAndReportCoarseningCollisions; call sites in maintainRowTime + flushDeferredRebuilds; getEventEmitter() on MaterializedViewManagerContext
  - packages/quereus/src/index.ts                                 # export MaintenanceCollisionEvent
  - packages/quereus/test/mv-coarsening-collision-telemetry.spec.ts  # NEW — 9 cases
  - docs/materialized-views.md                                    # § Coarsened backing keys — implemented telemetry bullet + accepted-limit correction
  - docs/migration.md                                             # § Convergence hazards (silent → observable); removed the Current-gaps bullet
----

# Review: MV key-coarsening collision telemetry

## What was built (implement stage)

The create-time key-coarsening warning says the LWW-merge hazard *exists*; this
ticket adds the runtime signal that says it is *happening*. When row-time
maintenance upserts under a coarsened backing key K′ and replaces a backing row
whose **source identity differs** from the incoming row's (two distinct
source-key tuples — `'Bob'`/`'bob'` — collapsing onto one K′ row, LWW), the
engine fires a host-observable event and increments a cumulative counter.

**Collision channel on `DatabaseEventEmitter`** (`database-events.ts`), a third
channel parallel to the data/schema channels and sharing their exact
transaction-batching discipline:
- `MaintenanceCollisionEvent { schemaName, tableName, key (K′ values), weakenedColumns, oldRow, newRow, remote? }` (exported; `remote` reserved/unset — out of scope).
- `collisionListeners`, `batchedCollisionEvents`, `collisionEventLayers` (savepoint layers), and a cumulative `collisionCounts: Map<lowercased schema.table, number>`.
- `onMaintenanceCollision(listener)`, `hasCollisionListeners()`, `queueCollision(event)` (batch-or-emit, mirrors `emitAutoDataEvent`), private `emitCollisionEvent` (increments counter THEN notifies — counter first, so it is maintained even with no subscriber; per-listener try/catch isolation).
- Lifecycle participation in `startBatch`/`flushBatch`/`discardBatch`/`beginSavepointLayer`/`rollbackSavepointLayer`/`releaseSavepointLayer`/`removeAllListeners`. Counter increments in `flushBatch` only (committed-collisions-only); dropped on `discardBatch`/savepoint rollback.
- `getMaterializedViewCollisionStats()` returns a fresh `ReadonlyMap` copy (caller cannot mutate the live counter).

**Detection** (`database-materialized-views.ts`):
- `coarseningWatch?: ReadonlyArray<CoarseningWatchColumn>` on `MaintenancePlanCommon`, precomputed once at registration via `buildCoarseningWatch(mv)` — `undefined` unless `mv.derivation.coarsenedKey` is stamped (the **zero-overhead gate** for non-coarsened MVs). Each entry maps a weakened K′ column name → backing index (via `mv.columnIndexMap`) + source/output collations.
- `detectAndReportCoarseningCollisions(plan, backingChanges)` — gated on `coarseningWatch`; for each `'update'` change, compares `compareSqlValues(oldRow[i], newRow[i], sourceCollation)` per weakened column; any divergence under the *source* collation ⇒ queue one event. The `key` payload is the full K′ key (from `coarsenedKey.columns` via `columnIndexMap`) read from `newRow`. `insert`/`delete` are never collisions.
- Called from BOTH `maintainRowTime` (bounded-delta arms; the canonical coarsened shape rides `inverse-projection`) and `flushDeferredRebuilds` (full-rebuild floor; the `replace-all` collation-keyed diff realizes the same merge). Observe-only — does not consume/reorder the cascade's `BackingRowChange`s.

**Public API** (`database.ts`): `db.onMaintenanceCollision(...)` and `db.getMaterializedViewCollisionStats()`; `getEventEmitter()` added to `MaterializedViewManagerContext` (the `Database` already implements it).

## Use cases / test coverage

`test/mv-coarsening-collision-telemetry.spec.ts` (9 cases, all passing):
- **steady-state LWW merge** (inverse-projection arm) — one event with `key`/`weakenedColumns`/`oldRow`/`newRow`, counter == 1.
- **zero-overhead invariant** — a provable-key MV under the same colliding-shaped write fires nothing, counter never seeded.
- **same-source non-key update** (`email` change) — not a collision.
- **full-rebuild floor** (`where e in (subquery)` coarsened body) — reports identically.
- **multi-column coarsened key** — reports on weakened-column divergence while the non-weakened key column matches; a distinct-non-weakened-column write is an insert (no collision).
- **rolled-back transaction** — nothing emitted, counter unchanged; a subsequent committed collision still fires (channel intact).
- **ingest seam** — `db.ingestExternalRowChanges([...], { maintainMaterializedViews: true })` colliding row fires the event.
- **listener error isolation** — a throwing listener does not break the others or the counter.
- **ACCEPTED LIMIT** — pins the known false positive below.

## Validation performed

- `yarn workspace @quereus/quereus test` → **6157 passing, 9 pending, 0 failing**.
- `yarn workspace @quereus/quereus lint` → clean (eslint + `tsc -p tsconfig.test.json`).
- `yarn typecheck` (src) → clean.
- Did NOT run `test:store` (the ticket's Validation section specifies the memory suite + lint only). Detection is host-agnostic — it reads the `BackingRowChange[]` the host returns, and the store host's `applyMaintenance` update-reporting shape is already pinned by `quereus-store/test/backing-host.spec.ts`. Store parity is a reasonable reviewer/CI follow-up but not expected to differ.

## Honest gaps / where the reviewer should look

1. **The ticket's "accepted limit" rationale was WRONG — corrected.** The ticket claimed a single-source-row in-place weakened-key-column case rename (`update contact_v1 set handle='bob' where handle='Bob'`) is "unreachable … PK-value updates decompose into delete + insert". **It does not.** I verified empirically: the DML executor reports a PK-changing source UPDATE as a single `{op:'update'}` (`dml-executor.ts:845`), so this case **does** fire a (false-positive) collision. Per the ticket's directive ("accept it, document it, do NOT add source-PK provenance plumbing"), I accepted the limit, pinned it with an explicit `ACCEPTED LIMIT` test, and **corrected both docs** to describe the true behavior rather than the incorrect rationale. Reviewer should confirm the accept-and-document stance (vs. wanting it suppressed) is the right call.
2. **Detection always runs for coarsened MVs, regardless of listeners.** The zero-overhead guarantee is for *non-coarsened* MVs only (per ticket). A coarsened MV always scans its weakened watch columns per `'update'` change and always maintains the counter — intended, but confirm the cost is acceptable (the watch list is tiny; collisions queue only on actual divergence).
3. **Counter cleared on `removeAllListeners()`** (called from `db.close()`). Not specified by the ticket — a judgment call (lifecycle cleanup alongside listener/batch clearing). Confirm acceptable; the counter is cumulative-since-open telemetry.
4. **K′ `key` indices resolved per-batch in the helper** (from `coarsenedKey.columns` via `columnIndexMap`), not precomputed onto `coarseningWatch` — honoring the ticket's prescribed `coarseningWatch: ReadonlyArray<CoarseningWatchColumn>` type. Off the hot path (resolved once per maintenance apply, only when a watch exists). A reviewer who prefers precomputation could fold K′ key indices into the plan.
5. **Counter increment path symmetry.** `emitCollisionEvent` increments on both the batched (`flushBatch`) and the immediate (non-batching `queueCollision`) path. In practice maintenance always runs inside a transaction batch, so the immediate path is defensive only.

## Out of scope (per ticket; not implemented)

- `remote` flag distinguishing ingest-seam vs local-DML collisions — payload field reserved but unset (would need remote-ness threaded through `maintainRowTime`; file a backlog ticket if wanted).
- SQL / introspection-TVF surface for the counter (programmatic API only, matching the `coarsenedKey` stamp's posture).
- REFRESH path — re-fills and rejects duplicate K′ keys loudly (`assertRefreshRowsAreSet`), so it is not a silent-merge site and needs no telemetry.
