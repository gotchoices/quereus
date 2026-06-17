description: Track, per shared (basis) table, whether the current app still uses it directly, only as the source of a converted table, or not at all — and remember when each table crossed those lines, so a developer can tell when a legacy table is safe to retire.
prereq:
files:
  - packages/quereus/src/vtab/module.ts                         # notifyLensDeployment hook (data source; no change)
  - packages/quereus/src/schema/lens.ts                         # LensDeploymentSnapshot / LensTableSnapshot / relationBacking types
  - packages/quereus/src/schema/derivation.ts                   # TableDerivation.sourceTables
  - packages/quereus/src/schema/schema.ts                       # Schema.getAllTables()
  - packages/quereus-store/src/common/store-module.ts           # add notifyLensDeployment forwarder + listener hook
  - packages/quereus-isolation/src/isolation-module.ts          # already forwards notifyLensDeployment (verify pass-through)
  - packages/quereus-sync/src/metadata/keys.ts                  # add a key prefix for lifecycle records
  - packages/quereus-sync/src/metadata/                         # new BasisLifecycleStore (mirror quarantine.ts / tombstone serializer)
  - packages/quereus-sync/src/sync/sync-manager-impl.ts         # recordLensDeployment + getBasisTableLifecycle
  - packages/quereus-sync/src/sync/manager.ts                   # SyncManager interface additions
  - packages/quereus-sync/src/sync/events.ts                    # onBasisTableLifecycle event (mirror onUnknownTable)
  - packages/quereus-sync/src/create-sync-module.ts             # expose the recorder for wiring
  - packages/quoomb-web/src/worker/quereus.worker.ts            # wire store forwarder → sync recorder
  - docs/migration.md                                           # § 2 Converge, § Current gaps (mark mapped-since bookkeeping landed)
difficulty: hard
----

# Basis-table lifecycle classification & persistent bookkeeping (static half)

This is the static foundation for basis-table retirement. It establishes the
three-state classification (`docs/migration.md` § 2 Converge) and the durable
mapped-since / unmapped-since record. The **dynamic** network signal and the
**eviction** policy build on this in `basis-eviction-policy` (prereq: this
ticket).

## Why no new core-engine surface

Everything needed already crosses the existing seam:

- **Directly-mapped set** — `notifyLensDeployment(db, logicalSchemaName, snapshot)`
  (`module.ts`) hands every registered module the `LensDeploymentSnapshot`. Each
  `LensTableSnapshot.relationBacking` is keyed by basis-relation `schema.table`
  (lowercased) — exactly the basis relations the deployed lens directly backs a
  logical column with (`lens.ts`).
- **Derivation-source set** — the basis schema's own tables carry
  `TableSchema.derivation?.sourceTables` (lowercased `schema.table`), the tables a
  maintained table reads (`derivation.ts`). The module enumerates the basis
  schema via `db.schemaManager` → `Schema.getAllTables()`.
- **Basis membership** — the same enumeration gives the full set of basis tables.

So the classification is a pure function of `(snapshot, basis schema)`, both
reachable from the `db` the hook already passes. The engine boundary in
`lens.md` holds unchanged.

## Plumbing: snapshot → sync bookkeeping

`@quereus/sync` is **not** a VTab module, so it cannot receive
`notifyLensDeployment` directly. The `StoreModule` (the basis-backing host, and
the only host with both persistence and a `db` handle) is the forwarder:

```
engine apply schema X
  → notifyLensDeployment(db, "X", snapshot)   [fires on every module]
      → StoreModule.notifyLensDeployment(...)  [new]
          → this.lensDeploymentListener?.(db, "X", snapshot)   [guarded]
              → SyncManager.recordLensDeployment(db, "X", snapshot)  [wired in worker]
```

- `StoreModule` gains `setLensDeploymentListener(fn)` and an optional
  `notifyLensDeployment` that invokes it. **The listener call is wrapped in
  try/catch + structured-log** — lifecycle bookkeeping is advisory and must
  never abort a schema apply. (The engine's firing contract says a throwing
  notification aborts `apply schema X`; we deliberately swallow here so a
  bookkeeping bug cannot brick deploys. Document this inversion at the call
  site.)
- Layering: `@quereus/store` must not depend on `@quereus/sync`. The listener is
  a plain `(db, logicalSchemaName, snapshot) => void | Promise<void>`; the
  worker (which already depends on both, see `quereus.worker.ts`
  `initializeSyncModule`) wires `StoreModule` → `SyncManager`. `@quereus/sync`
  already depends on `@quereus/quereus` types (`TableSchema`, etc.), so
  `recordLensDeployment` can take `Database` + `LensDeploymentSnapshot`
  directly. Expose the recorder on the `SyncManager` interface; surface it from
  `createSyncModule` if the worker needs a typed handle.
- `IsolationModule` already forwards `notifyLensDeployment` to its underlying
  module — verify the store forwarder rides through it unchanged.

## Classification & the per-logical-schema scoping problem

The snapshot is **scoped to one logical schema** (firing contract in
`module.ts`). A basis table can be directly mapped by logical schema `A` and not
by `B`; it is "directly mapped" while *any* deployed lens maps it. Rather than
enumerate all deployed logical schemas (no public enumerator exists, and adding
one would be the avoidable engine change), **store each logical schema's
contribution and OR them**:

Per basis table (`schema.table` lowercased), the persisted record:

```ts
type BasisLifecycleState =
  | 'directly-mapped'        // some deployed lens backs a logical column with it
  | 'derivation-source-only' // referenced solely as a maintained table's source (the "now legacy" signal)
  | 'unreferenced'           // in basis, neither mapped nor a derivation source
  | 'detached';              // no longer in the basis schema; physical storage may linger (eviction candidate)

interface BasisTableLifecycleRecord {
  schema: string;
  table: string;
  state: BasisLifecycleState;
  /** Logical schema names (lowercased) whose latest deploy directly maps this table. */
  mappedBy: string[];
  /** True iff some maintained table in the current basis lists it in sourceTables. */
  derivationSource: boolean;
  /** True iff the table is present in the basis schema as of the last deploy. */
  inBasis: boolean;
  /** Wall-clock ms when the aggregate state last entered `directly-mapped`. */
  mappedSince?: number;
  /** Wall-clock ms when it last left `directly-mapped` (the retirement hint timestamp). */
  unmappedSince?: number;
  /** Populated by `basis-eviction-policy` (dynamic signal); reserve the field here. */
  lastDirectlyMappedWriteAt?: number;
  /** Populated by `basis-eviction-policy` (override knob); reserve the field here. */
  evictPolicy?: 'never' | 'immediate' | number;
}
```

`recordLensDeployment(db, logicalSchemaName, snapshot)`:

- **directlyMapped(this schema)** = union of `relationBacking` keys across
  `snapshot.tables`. (An empty deploy → empty set → this schema maps nothing,
  clearing its prior contributions.)
- Resolve the basis schema by `snapshot.basisSchemaName` via `db.schemaManager`
  (use the schema-by-name accessor; `getMainSchema()` is the common case but the
  basis may be an attached schema). Enumerate `getAllTables()`:
  **basisMembership** = all table keys; **derivationSources** = union of every
  table's `derivation?.sourceTables`.
- For each key in `basisMembership ∪ derivationSources ∪ {stored records}`:
  - Update `mappedBy`: add `logicalSchemaName` if in directlyMapped, else remove.
  - Recompute `derivationSource` and `inBasis` from the current basis.
  - Aggregate `state`: `mappedBy.length > 0` → directly-mapped; else
    `derivationSource` → derivation-source-only; else `inBasis` → unreferenced;
    else → detached.
  - Detect transition vs. the stored record; stamp `mappedSince` on entry into
    directly-mapped, `unmappedSince` on exit from it; persist; emit
    `onBasisTableLifecycle` only on an actual state change (idempotent re-apply
    emits nothing).
- Timestamps: wall-clock `Date.now()` at record time (the hook carries none; the
  sync layer already uses `Date.now()` for GC). Acceptable — these feed a
  retention horizon measured in days.

Persist in the sync KVStore under a new `SYNC_KEY_PREFIX` entry (e.g.
`BASIS_LIFECYCLE = 'bl:'`, key `bl:{schema}.{table}`), with a
serialize/deserialize pair mirroring `metadata/quarantine.ts` /
tombstone serialization. A `BasisLifecycleStore` (new file under
`packages/quereus-sync/src/metadata/`) owns read/write/iterate, instantiated in
the `SyncManagerImpl` constructor alongside the other metadata stores.

## Surfacing (static)

- **Event**: `onBasisTableLifecycle(listener)` on `SyncEventEmitter` /
  `SyncEventEmitterImpl`, mirroring `onUnknownTable` (interface +
  listener Set + `emit*`). Payload `{ schema, table, previousState, newState,
  at }`. The `directly-mapped → derivation-source-only` transition is the
  developer's "safe to schedule retirement" signal — call it out in the event
  doc comment.
- **Introspection**: `getBasisTableLifecycle(): BasisTableLifecycleRecord[]` on
  `SyncManager`, reading the persisted records (survives restart — no
  in-memory-only state). `lastDirectlyMappedWriteAt` / `evictPolicy` come back
  as the reserved (undefined) fields until `basis-eviction-policy` populates
  them.
- A SQL-level TVF over the same records is a nice-to-have but **out of scope** —
  the method + event are the contract. (Parked: see TODO.)

## Edge cases & interactions

- **Empty deploy** (logical schema fully removed → `snapshot.tables` empty):
  must clear that logical schema from every record's `mappedBy`; tables it was
  the sole mapper of transition to derivation-source-only / unreferenced and get
  `unmappedSince` stamped. Drive the clear from each stored record's `mappedBy`,
  not from the (empty) snapshot.
- **Multiple logical schemas mapping one basis table**: stays directly-mapped
  until the *last* mapper drops it; `unmappedSince` stamps only on the final
  exit, and re-entry (a later deploy re-maps it) clears `unmappedSince` and
  re-stamps `mappedSince`.
- **Idempotent re-apply**: identical snapshot → no state change, no event,
  timestamps untouched. Assert this — spurious events would mislead the
  retirement hint.
- **Restart**: records are KV-durable; `getBasisTableLifecycle` reads them with
  no prior deploy in the session. `derivationSource`/`inBasis` reflect the last
  computed deploy (only recomputed on the next notification) — correct, since
  basis membership only changes via deploy.
- **Table leaves the basis** (present in a prior record with `inBasis=true`, now
  absent from `basisMembership`): `inBasis=false`, state → detached (storage may
  linger — `lens.md`: detach retains storage). This is the hand-off point to
  `basis-eviction-policy`.
- **surrogateMemberKeys**: `LensTableSnapshot.surrogateMemberKeys` marks a
  deferred surrogate-split member that backs the table indirectly. Treat such
  keys as **referenced** (fold into the directly-mapped/derivation set, not
  eviction candidates) so a deferred surrogate member is never misclassified as
  unreferenced. Cover with a test.
- **Memory-backed basis tables**: the forwarder lives on `StoreModule`; a basis
  backed only by the memory module has no forwarder (sync-with-persistence
  implies the store module). Classification still considers all basis tables the
  store module sees via `db`; eviction (next ticket) filters to store-backed.
  Document the assumption.
- **Basis drift**: `snapshot.basisHash` can detect an out-of-band basis change;
  not required here, but log a warning on mismatch vs. the prior recorded hash
  rather than silently reclassifying.
- **Throwing listener never aborts deploy**: assert that a forced exception in
  the recorder does not propagate out of `apply schema` (try/catch at the store
  forwarder).

## Key tests (TDD)

- Deploy v1 lens over basis `{Contact_v1}` → `Contact_v1` is `directly-mapped`,
  `mappedSince` set.
- Expand: add `Contact_v2` maintained from `Contact_v1`, lens still on
  `Contact_v1` → `Contact_v2` directly-mapped, `Contact_v1` still
  directly-mapped (also now a derivation source — directly-mapped wins).
- Flip the lens to `Contact_v2` → `Contact_v1` transitions to
  `derivation-source-only`, `unmappedSince` stamped, `onBasisTableLifecycle`
  fires with `derivation-source-only`.
- Drop the `Contact_v1` derivation + remove from basis → `Contact_v1` → detached.
- Two logical schemas, one still mapping `Contact_v1` → stays directly-mapped
  until both flip.
- Empty deploy clears contributions correctly.
- Idempotent re-apply emits no events and preserves timestamps.
- Restart: reopen the KV store, `getBasisTableLifecycle` returns the persisted
  records with intact timestamps.
- A throwing recorder does not abort `apply schema`.

## TODO

- Add `BASIS_LIFECYCLE` prefix to `metadata/keys.ts`; create `BasisLifecycleStore`
  (serialize/deserialize + iterate, mirror `quarantine.ts`).
- Implement `StoreModule.setLensDeploymentListener` + guarded `notifyLensDeployment`.
- Implement `SyncManagerImpl.recordLensDeployment` (per-schema contribution OR,
  basis enumeration, transition detection, timestamps, persistence).
- Add `onBasisTableLifecycle` to events; `getBasisTableLifecycle` to
  `SyncManager` interface + impl.
- Wire store forwarder → sync recorder in `quereus.worker.ts`.
- Tests per above (add a sync spec; reuse the migration capstone's
  declare/apply shape where convenient).
- Update `docs/migration.md` § 2 Converge and § Current gaps to mark the static
  mapped-since / unmapped-since bookkeeping as landed.
- Parked (file a `backlog/` ticket, do not build here): SQL TVF
  (`quereus_basis_lifecycle()`) over the same records for in-SQL introspection.
