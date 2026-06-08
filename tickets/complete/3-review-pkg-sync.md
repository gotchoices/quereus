---
description: Comprehensive review of quereus-sync package (CRDT replication, HLC, metadata stores, sync protocol)
prereq: [review-pkg-store]

---

# Sync Package Review

## Goal

Adversarial review of the `@quereus/sync` package: test from interface without implementation bias, inspect code quality, and ensure documentation accuracy.

## Scope

- **Source**: `packages/quereus-sync/src/` — SyncManager, HLC, metadata stores (column-version, tombstones, peer-state, change-log, schema-migration, schema-version), protocol types, events, store adapter, factory
- **Tests**: `packages/quereus-sync/test/` — HLC, site ID, metadata stores (pre-existing 134 tests); 9 new interface-driven e2e tests (143 total)
- **Docs**: `packages/quereus-sync/README.md`

## Tests Added

Added 9 interface-driven tests to `packages/quereus-sync/test/sync/sync-protocol-e2e.spec.ts`:

### Idempotency (2 tests)
- Applying the same ChangeSet twice produces identical state (second apply: 0 applied, all skipped)
- Applying the same deletion twice produces identical state

### Convergence (1 test)
- Two replicas applying same changes in different order converge to identical column versions and values

### Tombstone Pruning (2 tests)
- Expired tombstones (1ms TTL) are pruned; second prune returns 0
- Non-expired tombstones (60s TTL) are not pruned

### Delta Sync with sinceHLC (1 test)
- `getChangesSince` with sinceHLC returns only changes with HLC > sinceHLC

### Multiple Tables (1 test)
- Syncing data across 3 different tables (users, products, orders) independently

### Tombstone Blocking (1 test)
- `allowResurrection=false` blocks writes to deleted rows even with newer HLC

### Null Column Values (1 test)
- Null values round-trip correctly through sync (apply → getChangesSince)

## Code Quality Observations

### Issues Noted (follow-up tasks created)

**Critical:**
- Silent failure on missing primary key (`handleDataChange` line 202) — returns without logging
- Unhandled errors in async event handlers (`handleDataChange`/`handleSchemaChange` are async but called from sync event emitters)
- Inconsistent conflict event emission — only emitted for local-wins, not remote-wins
- No error boundary around `applyToStore` callback in `applyChanges` two-phase flow

**High Priority:**
- O(N*M) complexity in `getSnapshotStream` — iterates ALL column versions per table to count entries
- HLC serialization duplicated 3 times (lines 234-239, 298-303, 380-387)
- `getSnapshotStream` / `resumeSnapshotStream` are ~130 lines each of nearly identical code
- `GetTableSchemaCallback` type defined in both `create-sync-module.ts` and `sync-manager-impl.ts`

**Medium:**
- `console.warn` for missing table schema — not controllable, noisy in tests
- No input validation in `createSyncModule` factory
- Metadata clearing in `applySnapshotStream` not resumable (if interrupted, existing metadata is already gone)

### Positive Findings

- Solid CRDT semantics: column-level LWW with HLC ordering works correctly
- Two-phase apply (resolve → apply to store → commit metadata) is a good crash-safety pattern
- Echo prevention (skip own siteId) correctly handles hub-and-spoke topology
- Tombstone management with configurable TTL and resurrection flag is well-designed
- Schema version conflict resolution with "most destructive wins" semantics is sound
- Change log as HLC-indexed secondary index enables efficient delta sync
- Protocol types are clean and transport-agnostic (JSON/MessagePack/protobuf serializable)
- Key encoding with big-endian HLC gives correct lexicographic ordering
- Streaming snapshots with checkpoint-based resumption is a good design
- All 143 tests pass consistently

## Documentation Review

**README**: Had several inaccuracies, all fixed:
- `createSyncModule` return type corrected (`{ syncManager, syncEvents }`, not `{ syncModule, ... }`)
- Snapshot API method names corrected (`getSnapshotStream`, `applySnapshotStream`)
- `applyChanges` signature corrected (no per-call callback)
- Event name corrected (`onConflictResolved`, not `onConflict`)
- Architecture diagram updated to include SchemaMigrationStore and SchemaVersionStore
- `createStoreAdapter` signature corrected (takes options object)
- Added streaming snapshot and checkpoint/resume documentation
- Added `SyncConfig`/`DEFAULT_SYNC_CONFIG` and `ApplyResult` to protocol types list
- Fixed stale comment in `index.ts`

## Follow-Up Tasks Created

- `tasks/fix/sync-manager-dry-violations.md` — HLC serialization duplication, snapshot stream duplication, type duplication
- `tasks/fix/sync-manager-error-handling.md` — Silent failures, unhandled async, missing error boundaries, inconsistent conflict events
- `tasks/fix/sync-snapshot-stream-perf.md` — O(N*M) performance bug in snapshot entry counting
- `tasks/plan/sync-manager-decomposition.md` — Decompose 1,676-line implementation into focused modules

## Files Modified

- `packages/quereus-sync/test/sync/sync-protocol-e2e.spec.ts` — Added 9 interface-driven tests (lines 1377-1683)
- `packages/quereus-sync/README.md` — Fixed API documentation to match implementation
- `packages/quereus-sync/src/index.ts` — Fixed stale usage comment

## Test Validation

143 passing, 0 pending. Run with:
```bash
yarn workspace @quereus/sync test
```

