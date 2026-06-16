description: Renamed the sync "tombstone TTL" setting to "retention horizon" everywhere, with no change in behavior.
files:
  - packages/quereus-sync/src/sync/protocol.ts
  - packages/quereus-sync/src/sync/sync-manager-impl.ts
  - packages/quereus-sync/src/metadata/tombstones.ts
  - packages/quereus-sync/src/create-sync-module.ts
  - packages/sync-coordinator/src/config/types.ts
  - packages/sync-coordinator/src/config/loader.ts
  - packages/sync-coordinator/src/service/coordinator-service.ts
  - packages/sync-coordinator/src/service/store-manager.ts
  - packages/quereus-sync/test/sync/sync-protocol-e2e.spec.ts
  - docs/sync.md
  - docs/sync-coordinator.md
  - docs/migration.md
  - packages/quereus-sync/README.md
----

## Summary

Clean rename of `tombstoneTTL` → `retentionHorizonMs` (config field) and
`SYNC_TOMBSTONE_TTL` → `SYNC_RETENTION_HORIZON_MS` (env var) across
`@quereus/sync` and `@quereus/sync-coordinator`, plus docs. No behavior change:
same 30-day default, same tombstone-GC / delta-sync-eligibility / retirement
logic. The new name reflects the setting's true scope — it is the single
"changes older than T are not guaranteed deliverable" horizon, not merely a
tombstone TTL.

## Review findings

### Scope / completeness — verified clean
- **No straggler references.** `find_references` over the indexed corpus and a
  repo-wide `grep` for `tombstoneTTL` / `TOMBSTONE_TTL` / `SYNC_TOMBSTONE` find
  zero hits outside this ticket file. JSON/config files carry no old key. The
  rename is total.
- **Spread path holds.** The coordinator's `store-manager.ts` uses an inline
  `syncConfig` type (not `SyncSettings`), but `createSyncModule`'s options
  extend `Partial<SyncConfig>`, so `retentionHorizonMs` flows through the spread
  in `create-sync-module.ts` automatically. Confirmed by reading the file — the
  handoff's "verify the spread stays in sync" concern is satisfied for the
  current shape.
- **Consumers updated.** `protocol.ts` (type + `DEFAULT_SYNC_CONFIG`),
  `tombstones.ts` (constructor field + `pruneExpired`), `sync-manager-impl.ts`
  (`canDeltaSync` + `pruneTombstones` + construction), coordinator
  `types.ts`/`loader.ts`/`coordinator-service.ts`/`store-manager.ts` all
  consistent.

### Docs — verified, one gap fixed inline
- `docs/sync.md`, `docs/migration.md`, `docs/sync-coordinator.md` (config
  interface), and `packages/quereus-sync/README.md` all reflect the new name.
- **Fixed inline (minor):** the coordinator's Environment Variables table in
  `docs/sync-coordinator.md` never documented the sync-settings env vars. Since
  the rename introduced a brand-new env var name with no documentation, added
  rows for `SYNC_RETENTION_HORIZON_MS` and `SYNC_BATCH_SIZE` (the latter was a
  pre-existing omission folded in for consistency).

### Type safety / cleanup
- No `any` introduced; doc comments on the renamed type are expanded and
  accurate. The expanded `SyncConfig.retentionHorizonMs` comment correctly
  states the field bounds GC, delta-sync eligibility, AND retirement guidance.

### Tests
- Implementer added an assertion pinning
  `DEFAULT_SYNC_CONFIG.retentionHorizonMs === 30 * 24 * 60 * 60 * 1000` — good
  regression guard against an accidental default change during a future rename.
- Existing tombstone-pruning tests exercise both the expired (1 ms horizon) and
  non-expired (60 s horizon) paths through the renamed field, so the
  behavior-preserving claim is covered, not just asserted.
- For a pure rename this is adequate coverage; no new edge/error paths were
  introduced to test.

### Backwards compatibility
- No alias for the old name (field or env var) was added — consistent with
  AGENTS.md "Don't worry about backwards compatibility yet." Any external
  consumer setting `tombstoneTTL` / `SYNC_TOMBSTONE_TTL` will now silently fall
  back to the 30-day default; acceptable pre-1.0 per project policy.

### Findings filed as new tickets
- None. The one issue found (undocumented env vars) was minor and fixed inline.

## Build & test
- `yarn workspace @quereus/sync run test` — 261 passing.
- `yarn workspace @quereus/sync-coordinator run test` — 121 passing.
- (Error-path test output prints intentional `[Sync] Error ...` lines; all
  green.)
- `yarn build` was clean per the implement stage; no source signatures changed
  beyond the rename.
