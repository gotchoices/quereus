description: Runtime collision telemetry for coarsened-key materialized views — a host-observable `onMaintenanceCollision` event + cumulative counter fired when row-time maintenance LWW-merges two distinct source-key tuples under a coarsened backing key. The operational complement to the implemented create-time key-coarsening warning.
files:
  - packages/quereus/src/core/database-materialized-views.ts
  - packages/quereus/src/core/database-events.ts
  - packages/quereus/src/core/database.ts
  - packages/quereus/src/core/database-transaction.ts
  - packages/quereus/src/schema/derivation.ts
  - packages/quereus/src/schema/view.ts
  - packages/quereus/test/coarsened-backing-key.spec.ts
  - packages/quereus/test/database-events.spec.ts
  - docs/materialized-views.md
  - docs/migration.md
difficulty: medium
----

# MV key-coarsening collision telemetry

Once a coarsened-key materialized view exists (`coarsenedKey` stamped on
`TableDerivation`, the create-time warning emitted — see
`docs/materialized-views.md` § Coarsened backing keys), in-window collisions are
silent by design: a colliding source row arrives (local DML **or** the
`ingestExternalRowChangeBatch` ingest seam — no peer concept needed), the keyed
upsert under the coarsened backing key K′ last-writer-wins, and two distinct
source rows merge into one derived row that oscillates until the source rows are
merged.

The create-time warning tells the developer the hazard *exists*. This ticket
adds the runtime signal that tells the operator it is *happening*: a
host-observable **event** plus a cumulative **counter**, fired from row-time
maintenance whenever an upsert under K′ replaces a backing row whose **source
identity differs** from the incoming row's.

This is purely a core-engine surface (no `@quereus/sync` dependency, no peer
concept). It rides the existing `DatabaseEventEmitter` transaction-batching
discipline so a collision is reported only on the commit that realized it.

## Detection — where and how

**Where.** In `MaterializedViewManager` (`database-materialized-views.ts`), at
the two row-time maintenance sites that already receive the realized
`BackingRowChange[]`:

- `maintainRowTime` — after `applyMaintenancePlan(...)` returns `backingChanges`
  (currently ~line 781), the bounded-delta arms (the canonical coarsened shape
  rides the `inverse-projection` covering arm).
- `flushDeferredRebuilds` — after `applyFullRebuild(...)` returns
  `backingChanges` (currently ~line 848), the full-rebuild floor whose
  collation-keyed `replace-all` diff also realizes the LWW merge (the
  `where e in (subquery)` coarsened body in `coarsened-backing-key.spec.ts`
  exercises this arm).

Both call a single shared private helper
`detectAndReportCoarseningCollisions(plan, backingChanges)`.

**Zero-overhead gate.** The helper's first line is
`const watch = plan.coarseningWatch; if (!watch) return;`. `coarseningWatch` is
precomputed **once at registration** (`registerMaterializedView` /
`buildMaintenancePlan`) and is `undefined` unless
`plan.mv.derivation.coarsenedKey` is present. A non-coarsened MV never builds a
watch list, never scans `backingChanges`, never touches the collision channel —
the create path's coarsening flag is the only thing that arms detection.

`coarseningWatch` is a small precomputed array, one entry per **weakened** K′
column (from `coarsenedKey.weakened`):
`{ index: backingColumnIndex, sourceCollation, outputCollation, column }`, where
`index` is resolved from `coarsenedKey.weakened[].column` (a backing column name)
via `plan.mv.columnIndexMap`. Stored on `MaintenancePlanCommon` as optional
`coarseningWatch?: ReadonlyArray<CoarseningWatchColumn>` so both bounded-delta
and full-rebuild arms carry it uniformly.

**Criterion.** For each `BackingRowChange` with `op === 'update'`, compare
`compareSqlValues(change.oldRow[index], change.newRow[index], sourceCollation)`
for each watch column. If **any** weakened column differs under its *source*
(pre-coarsening, stricter) collation → a coarsening collision: the replaced
backing row came from a distinct source-key tuple, merged under K′'s output
collation. `insert`/`delete` changes are never collisions (new key / removal).

Why this is correct and false-positive-free for the canonical shape: an
`update` change here means the incoming row landed on an existing backing row
sharing K′ under the **output** collation (that is what makes it a replacing
upsert, not an insert). If those rows are *equal* under the source collation it
is the same source row's value being updated (e.g. an `email` change) — not
reported. If they *differ* under the source collation, two distinct source
identities (`'Bob'`/`'bob'`) collapsed onto one backing key — the LWW merge
`migration.md` § Convergence hazards warns about.

**Event payload + emission.** On a detected collision, queue a
`MaintenanceCollisionEvent` through the emitter (batched, see below):
`{ schemaName, tableName, key: SqlValue[] (the K′ key values from newRow),
weakenedColumns: string[] (the names that diverged), oldRow: Row, newRow: Row }`.
One event per realized colliding merge.

## Surface — `DatabaseEventEmitter` collision channel

Add a third event channel to `DatabaseEventEmitter`
(`database-events.ts`), parallel to the existing data/schema channels and
sharing the **same transaction-batching discipline** so a collision inside a
rolled-back transaction reports nothing:

- `MaintenanceCollisionEvent` interface (exported).
- `collisionListeners: Set<...>`, `batchedCollisionEvents`, and
  `collisionEventLayers` (savepoint layers) — mirroring the data/schema fields.
- `onMaintenanceCollision(listener): () => void` + `hasCollisionListeners()`.
- A queue method (e.g. `queueCollision(event)`) that pushes to the active store
  when `isBatching`, else emits immediately (mirror `emitAutoDataEvent`).
- Extend the lifecycle methods to handle the collision layer identically:
  `startBatch` (reset), `flushBatch` (emit on commit), `discardBatch` (drop on
  rollback), `beginSavepointLayer` / `rollbackSavepointLayer` /
  `releaseSavepointLayer`, and `removeAllListeners`.

**Cumulative counter.** The emitter maintains a `Map<string, number>`
(lowercased qualified `schema.table` → committed collision count), incremented
in `flushBatch` as each batched collision is emitted (so the count reflects only
committed collisions, consistent with event delivery, and survives a host that
never subscribed). Expose a read-only snapshot.

**`Database` public API** (`database.ts`), alongside `onDataChange` /
`onSchemaChange`:

- `onMaintenanceCollision(listener: (e: MaintenanceCollisionEvent) => void): () => void`
- `getMaterializedViewCollisionStats(): ReadonlyMap<string, number>`

The manager reaches the emitter through the `Database` it is constructed with
(`new MaterializedViewManager(this)`); add the emitter accessor to
`MaterializedViewManagerContext` (it already exposes `getEventEmitter()` for the
transaction manager — reuse it, or add an analogous narrow method).

No change to `database-transaction.ts` behavior is required beyond confirming
the collision batch is flushed/discarded via the existing
`flushBatch()`/`discardBatch()` calls in `commitTransaction` /
`rollbackTransaction` (those already drive the emitter — the new channel just
participates).

## Edge cases & interactions

- **Zero-overhead for non-coarsened MVs (must-test).** A provable-key or
  refining-lineage-key MV (`coarsenedKey === undefined`) builds no watch list and
  fires nothing under a colliding-shaped write — counter stays empty. This is the
  primary cost invariant.
- **Legitimate same-source-row update is not a collision.** Updating a non-key
  derived column (e.g. `email`) on an existing source row produces an `update`
  whose K′ columns are equal under the source collation → no event.
- **Single-source-row key-case change (accepted heuristic limit).** An in-place
  update that changes a *weakened key column's* value case for one source row
  (`update contact_v1 set handle='bob' where handle='Bob'`) — were it modeled as a
  replacing upsert — would be flagged though only one source row exists. In
  practice unreachable for the canonical shape: the weakened column is a projected
  source PK, and PK-value updates under key-based addressing decompose into a
  delete + insert (separate `delete`/`insert` changes, not a replacing `update`),
  so no false positive arises. Document this as an accepted limit — the telemetry
  is an operational signal, not an exact invariant. Do **not** add source-PK
  provenance plumbing to chase it.
- **Bounded-delta vs full-rebuild floor parity.** Both maintenance arms must
  report identically (the `inverse-projection` upsert and the `replace-all` diff
  both surface the merge as an `update` change). Cover both.
- **Multi-column coarsened key.** Only the weakened column(s) arm detection; a
  collision must be reported when a weakened column diverges under its source
  collation while non-weakened key columns match. (See the `mc_v` composite case
  in `coarsened-backing-key.spec.ts`.)
- **Ingest seam (the migration scenario).** A colliding source row applied via
  `Database.ingestExternalRowChanges` with `maintainMaterializedViews` on routes
  through `maintainRowTime` and must fire the event — this is the doc's
  in-window silent-merge case. No `remote` flag is required (see Out of scope).
- **Transaction rollback / savepoint.** A collision inside a transaction that
  rolls back (or inside a rolled-back savepoint) must emit nothing and not
  increment the counter. A committed transaction emits after commit.
- **MV-over-MV cascade.** Detection reads `backingChanges` but must not perturb
  the cascade — it is observe-only and runs independently of (does not consume or
  reorder) the `BackingRowChange`s routed onward.
- **Listener errors are isolated.** A throwing collision listener must not break
  emission to other listeners or the commit (mirror the try/catch in
  `emitDataEvent`/`emitSchemaEvent`).
- **Counter key collision across schemas.** Key the counter map on lowercased
  qualified `schema.table` so `main.m` and `other.m` are distinct.

## Out of scope (do not grow this ticket)

- **`remote` flag** distinguishing ingest-seam (peer) collisions from local DML —
  requires threading remote-ness through `maintainRowTime`. File a `backlog/`
  ticket if wanted; the event payload may reserve the field but leave it unset.
- **SQL / introspection-TVF surface** for the counter (programmatic API only here,
  matching the `coarsenedKey` stamp's programmatic-only posture).
- **REFRESH-statement path** — `refresh materialized view` re-fills and *rejects*
  duplicate K′ keys loudly (`assertRefreshRowsAreSet` → "must be a set"), so it is
  not a silent-merge site and needs no telemetry.

## Validation

- `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/mv-collision-test.log; tail -n 80 /tmp/mv-collision-test.log`
- `yarn workspace @quereus/quereus lint` (single-quote globs on Windows).

## TODO

- Add `MaintenanceCollisionEvent` + collision channel to `DatabaseEventEmitter`
  (listeners, batched store + savepoint layers, `queueCollision`, lifecycle
  participation in `startBatch`/`flushBatch`/`discardBatch`/`*SavepointLayer`/
  `removeAllListeners`) and the cumulative per-table committed counter.
- Expose `db.onMaintenanceCollision(...)` and
  `db.getMaterializedViewCollisionStats()` on `Database`; wire emitter access
  into `MaterializedViewManagerContext`.
- Add `coarseningWatch?: ReadonlyArray<CoarseningWatchColumn>` to
  `MaintenancePlanCommon`; populate it once at registration when
  `plan.mv.derivation.coarsenedKey` is present (map weakened column names →
  backing indices via `mv.columnIndexMap`, carry source/output collations).
- Implement `detectAndReportCoarseningCollisions(plan, backingChanges)` (gated on
  `coarseningWatch`; per-`update`-change source-collation compare of weakened
  columns) and call it from both `maintainRowTime` and `flushDeferredRebuilds`.
- New spec `test/mv-coarsening-collision-telemetry.spec.ts` (model on
  `coarsened-backing-key.spec.ts` + `database-events.spec.ts`):
  - steady-state LWW merge fires one event (key/weakenedColumns) + counter == 1;
  - non-coarsened MV under the same colliding-shaped write fires nothing
    (zero-overhead invariant);
  - same-source-row non-key update fires nothing;
  - full-rebuild-floor coarsened body (`where e in (subquery)`) also reports;
  - multi-column coarsened key reports on weakened-column divergence;
  - rolled-back transaction reports nothing / counter unchanged;
  - ingest-seam colliding row (`ingestExternalRowChanges` +
    `maintainMaterializedViews`) fires the event.
- Docs: update `docs/materialized-views.md` § Coarsened backing keys (the
  "Runtime collision telemetry is the planned operational complement" line) and
  `docs/migration.md` § Convergence hazards + § Current gaps to describe the
  implemented `onMaintenanceCollision` event and `getMaterializedViewCollisionStats`
  counter (was "planned").
