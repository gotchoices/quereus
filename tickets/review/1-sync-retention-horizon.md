description: Review the rename of tombstoneTTL → retentionHorizonMs across the sync packages and docs.
files:
  - packages/quereus-sync/src/sync/protocol.ts
  - packages/quereus-sync/src/sync/sync-manager-impl.ts
  - packages/quereus-sync/src/metadata/tombstones.ts
  - packages/sync-coordinator/src/config/types.ts
  - packages/sync-coordinator/src/config/loader.ts
  - packages/sync-coordinator/src/service/coordinator-service.ts
  - packages/sync-coordinator/src/service/store-manager.ts
  - packages/quereus-sync/test/sync/sync-protocol-e2e.spec.ts
  - docs/sync.md
  - docs/sync-coordinator.md
  - docs/migration.md
  - packages/quereus-sync/README.md
difficulty: easy
----

## What was done

Clean rename of `tombstoneTTL` → `retentionHorizonMs` (and `SYNC_TOMBSTONE_TTL` → `SYNC_RETENTION_HORIZON_MS`) throughout `@quereus/sync` and `@quereus/sync-coordinator`. No behavior change — same numeric default (30 days), same GC/delta-sync logic.

### Changes by file

- **`protocol.ts`** — `SyncConfig.tombstoneTTL` → `retentionHorizonMs` with expanded doc comment describing delivery-guarantee / retirement role; `DEFAULT_SYNC_CONFIG` updated to match.
- **`tombstones.ts`** — `TombstoneStore` constructor private field renamed; `pruneExpired` uses `this.retentionHorizonMs`.
- **`sync-manager-impl.ts`** — `TombstoneStore(kv, config.retentionHorizonMs)`; `canDeltaSync` and `pruneTombstones` use `config.retentionHorizonMs`; comment updated.
- **`config/types.ts`** (coordinator) — `SyncSettings.tombstoneTTL` → `retentionHorizonMs`; `DEFAULT_CONFIG` updated.
- **`config/loader.ts`** (coordinator) — env var `SYNC_TOMBSTONE_TTL` → `SYNC_RETENTION_HORIZON_MS`.
- **`coordinator-service.ts`** — `syncConfig` object key renamed.
- **`store-manager.ts`** — `StoreManagerConfig.syncConfig.tombstoneTTL?` → `retentionHorizonMs?`.
- **`sync-protocol-e2e.spec.ts`** — test fixtures use `retentionHorizonMs`; added assertion pinning `DEFAULT_SYNC_CONFIG.retentionHorizonMs === 30 * 24 * 60 * 60 * 1000`.
- **`docs/sync.md`**, **`docs/sync-coordinator.md`**, **`packages/quereus-sync/README.md`** — field name and env var updated.
- **`docs/migration.md` § 4 Contract** — Retention horizon bullet now names `retentionHorizonMs` as the concrete setting, notes that mapped-since bookkeeping is a separate pending piece (§ Current gaps).

### Build & test

`yarn build` — clean. `yarn test` — 6330 + 128 + 62 + 17 + 17 + 28 passing, 9 pending, 0 failing.

## Known gaps / reviewer focus

- No alias for the old name was added (per AGENTS.md "don't worry about backwards compatibility yet"); confirm this is acceptable for any external consumers.
- The `store-manager.ts` `syncConfig` type is an inline object (not reusing `SyncSettings`); it still correctly passes `retentionHorizonMs` to `createSyncModule` via the spread in `create-sync-module.ts`. Worth verifying the spread path stays in sync with any future `SyncConfig` additions.
- `docs/sync.md` lines 1127/1149 show usage examples passing `retentionHorizonMs` — the old API shape is no longer present in examples.
