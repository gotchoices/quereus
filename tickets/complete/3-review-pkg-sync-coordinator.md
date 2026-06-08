---
description: Comprehensive review of sync-coordinator package (coordinator service, transports, store management, S3 integration)
prereq: review-pkg-sync

---

# Sync Coordinator Package Review

## Goal

Adversarial review of the `@quereus/sync-coordinator` package: test from interface without implementation bias, inspect code quality, and ensure documentation accuracy.

## Scope

- **Source**: `packages/sync-coordinator/src/` — coordinator service, Fastify server, WebSocket/HTTP transports, store management, S3 integration, metrics
- **Tests**: `packages/sync-coordinator/test/` — config, metrics, service, HTTP, WebSocket, store-manager, s3-config
- **Docs**: `packages/sync-coordinator/README.md`

## Tests Added

Extended from 55 to 86 tests across 7 test files:

### New test files

**store-manager.spec.ts** (14 tests)
- validateDatabaseId: alphanumeric, empty, unsafe chars, custom hook (4 tests)
- acquire/release: first open, cached return, refCount decrement, floor at zero, separate stores (5 tests)
- isOpen/get: open state reporting, entry retrieval (2 tests)
- LRU eviction: evicts when maxOpenStores reached (1 test)
- shutdown: closes all stores, idempotent (2 tests)

**s3-config.spec.ts** (10 tests)
- buildBatchKey: no prefix, with prefix, timestamp sanitization (3 tests)
- buildSnapshotKey: no prefix, with prefix (2 tests)
- parseS3ConfigFromEnv: undefined when no bucket, minimal config, region, endpoint, credentials, partial credentials, forcePathStyle, keyPrefix (5+2 tests)

### Extended existing test files

**websocket.spec.ts** (+6 tests)
- Duplicate handshake → ALREADY_AUTHENTICATED error
- Unknown message type → UNKNOWN_MESSAGE error
- apply_changes authentication requirement
- apply_changes with empty changes array
- get_snapshot authentication requirement
- get_snapshot BigInt serialization bug (documents known bug)

**http.spec.ts** (+2 tests)
- GET /:databaseId/snapshot authentication requirement
- GET /:databaseId/snapshot content-type (application/x-ndjson)

**service.spec.ts** (+7 tests)
- getChangesSince: returns empty for new database
- applyChanges: handles empty changes array
- Authorization denial via onAuthorize hook
- token-whitelist: rejects missing token, accepts valid token
- getSnapshotStream: streams chunks for empty database
- isValidDatabaseId: validates database ID patterns

## Bug Found

**BigInt serialization in snapshot endpoints**: Both WS `handleGetSnapshot()` and HTTP `GET /:databaseId/snapshot` send raw `SnapshotChunk` objects containing `HLC` (BigInt `wallTime`) and `SiteId` (Uint8Array) through `JSON.stringify()`, which throws. The `get_changes` handler correctly uses `serializeChangeSet()` but no equivalent exists for snapshots. Tracked in `tasks/fix/sync-coordinator-snapshot-serialization-bug.md`.

## Code Quality Findings

### DRY violations
- `serializeChangeSet` duplicated in `websocket.ts` and `coordinator-service.ts`
- `StoragePathResolver` type + `defaultStoragePathResolver` duplicated in `s3-batch-store.ts` and `s3-snapshot-store.ts`
- `hasSnapshot()` stub always returns false

### Resource management issues
- **CRITICAL**: Store eviction race condition — refCount can change between check and `closeStore()` call
- Socket close during handshake leaks store reference (session not yet assigned)
- Handshake error catch block doesn't call `unregisterSession()`
- Cleanup interval can race with shutdown

### Error handling gaps
- WS snapshot handler has no try-catch around async iteration
- HTTP snapshot errors silently end response — clients get truncated stream
- `broadcastChanges()` socket.send() has no error handling
- Individual WS message handlers lack try-catch (all errors become generic MESSAGE_ERROR)
- `resume_snapshot` type defined but no handler case in switch

### Positive findings
- Clean separation: config → service → server layers
- Proper multi-tenant isolation via StoreManager with LRU eviction
- Extensible hooks system (auth, authorization, change validation)
- Good metrics coverage with Prometheus-compatible output
- Non-blocking S3 operations with `.catch()` for durability without latency impact

## Documentation Fixes

- README API endpoints table corrected: flat paths (`/sync/changes`) → parameterized paths (`/sync/:databaseId/changes`)

## Follow-up Tasks Created

- `tasks/fix/sync-coordinator-snapshot-serialization-bug.md` — BigInt serialization bug
- `tasks/fix/sync-coordinator-resource-leaks.md` — Eviction race, socket close leaks
- `tasks/fix/sync-coordinator-error-handling.md` — Error handling gaps + missing resume_snapshot
- `tasks/fix/sync-coordinator-dry-violations.md` — Duplicated code, hasSnapshot stub

## Test Validation

86 passing, 0 failing. Run with:
```bash
cd packages/sync-coordinator && yarn test
```

