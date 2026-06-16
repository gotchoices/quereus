description: Give the sync engine one clearly-named "how long are changes guaranteed deliverable" time setting, and use it both for cleaning up old delete-markers and for advising when a retired table is safe to drop.
files:
  - packages/quereus-sync/src/sync/protocol.ts          # SyncConfig.tombstoneTTL + DEFAULT_SYNC_CONFIG
  - packages/quereus-sync/src/sync/sync-manager-impl.ts  # TombstoneStore ctor, canDeltaSync, pruneTombstones
  - packages/quereus-sync/src/metadata/tombstones.ts     # TombstoneStore(kv, ttl) consumer
  - packages/sync-coordinator/src/config/types.ts        # coordinator config field
  - packages/sync-coordinator/src/config/loader.ts        # SYNC_TOMBSTONE_TTL env var
  - packages/sync-coordinator/src/service/coordinator-service.ts
  - packages/sync-coordinator/src/service/store-manager.ts
  - docs/sync.md                                          # config docs
  - docs/sync-coordinator.md
  - docs/migration.md                                    # § 4 Contract / Retirement
  - packages/quereus-sync/README.md
  - packages/quereus-sync/test/sync/sync-protocol-e2e.spec.ts  # tombstoneTTL-named tests
difficulty: easy
----

# Retention horizon as a first-class sync setting

`docs/migration.md` § 4 Contract (Retention horizon) is the spec. A CRDT
deployment already carries a single time bound — "changes older than T are not
guaranteed deliverable." Today that bound exists only as `SyncConfig.tombstoneTTL`,
a name that ties it specifically to tombstone GC and hides that it is the general
delivery-guarantee horizon that **retirement guidance also keys off**: drop a
legacy basis table no sooner than the horizon after its last directly-mapped
write, because a peer offline longer than the horizon was already outside the
delivery guarantee.

This ticket promotes that bound to a first-class, generally-named setting. There
is **no automated retirement code** — reclaiming storage and timing retirement is
the storage module's / application's / sync layer's job (migration.md § Contract).
The deliverable is the renamed, documented knob plus the retirement-timing
guidance that references it.

## Design

Rename `SyncConfig.tombstoneTTL` → `retentionHorizonMs` throughout `@quereus/sync`
and `@quereus/sync-coordinator`. Per AGENTS.md ("Don't worry about backwards
compatibility yet"), this is a clean rename — no alias retained.

```ts
export interface SyncConfig {
  /**
   * Retention horizon in milliseconds: changes older than this are not
   * guaranteed deliverable. Bounds tombstone GC AND delta-sync eligibility,
   * and is the bound retirement guidance keys off (drop a legacy basis table
   * no sooner than the horizon after its last directly-mapped write).
   * Default: 30 days.
   */
  retentionHorizonMs: number;
  // ...
}
```

- `TombstoneStore(kv, config.retentionHorizonMs)` — same value, clearer intent.
- `canDeltaSync` and `pruneTombstones` consume `config.retentionHorizonMs`.
- Sync-coordinator config: field `tombstoneTTL` → `retentionHorizonMs`; env var
  `SYNC_TOMBSTONE_TTL` → `SYNC_RETENTION_HORIZON_MS` (loader.ts); thread through
  `coordinator-service.ts` / `store-manager.ts`.
- `DEFAULT_SYNC_CONFIG.retentionHorizonMs = 30 * 24 * 60 * 60 * 1000` (unchanged
  value).

Docs: update `docs/sync.md`, `docs/sync-coordinator.md`, `packages/quereus-sync/README.md`
to the new name, and tighten `docs/migration.md` § 4 Contract so the Retention
horizon bullet names `retentionHorizonMs` as the concrete setting retirement keys
off. Note in migration.md that the **mapped-since bookkeeping** needed to know
"the last directly-mapped write" is a separate pending piece (already tracked in
migration.md § Current gaps) — out of scope here.

## Edge cases & interactions

- **Single source of truth.** After the rename there must be exactly one config
  field expressing the horizon; grep the repo for any residual `tombstoneTTL`
  (including docs, coordinator env parsing, and test fixtures) so no stale name
  survives and silently reads `undefined` (which would make `now - t > undefined`
  always false and disable GC).
- **Coordinator env parsing.** `loader.ts` does `parseInt(process.env.SYNC_TOMBSTONE_TTL, 10)`
  — rename the env key and keep the `isNaN`/default fallback intact so a missing
  env var still yields the 30-day default.
- **Default unchanged.** The numeric default (30 days) must not change; only the
  name moves. Assert the default in a test.
- **No behavior change to GC / delta-sync.** `pruneTombstones` and `canDeltaSync`
  must compute identically to before — this is a rename, not a semantics change.
  Existing tombstone-TTL tests should pass after renaming their references.
- **Cross-package build order.** `@quereus/sync-coordinator` depends on
  `@quereus/sync`; rename the producer first, then the consumer, and run a full
  `yarn build` so the coordinator's import of the renamed field type-checks.

## TODO

- Rename `tombstoneTTL` → `retentionHorizonMs` in `protocol.ts` (`SyncConfig` +
  `DEFAULT_SYNC_CONFIG`) and update its doc comment to describe the
  delivery-guarantee / retirement role.
- Update `sync-manager-impl.ts` (`TombstoneStore` ctor, `canDeltaSync`,
  `pruneTombstones`) and `metadata/tombstones.ts` to the new name.
- Update sync-coordinator: `config/types.ts`, `config/loader.ts` (env var
  `SYNC_RETENTION_HORIZON_MS`), `service/coordinator-service.ts`,
  `service/store-manager.ts`.
- Update docs: `docs/sync.md`, `docs/sync-coordinator.md`,
  `packages/quereus-sync/README.md`, and `docs/migration.md` § 4 Contract
  (Retention horizon bullet names `retentionHorizonMs`; note mapped-since
  bookkeeping is separate/pending).
- Update tests referencing `tombstoneTTL` (e.g. `sync-protocol-e2e.spec.ts`),
  add an assertion pinning the default to 30 days under the new name.
- `yarn build` then `yarn test` (and lint in `packages/quereus`) to confirm the
  rename is consistent across packages.
