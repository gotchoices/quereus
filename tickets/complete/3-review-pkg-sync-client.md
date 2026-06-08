---
description: Comprehensive review of sync-client package (WebSocket sync, serialization, reconnection, type safety)
prereq: review-pkg-sync

---

# Sync Client Package Review

## Goal

Adversarial review of the `@quereus/sync-client` package: test from interface without implementation bias, inspect code quality, and ensure documentation accuracy.

## Scope

- **Source**: `packages/quereus-sync-client/src/` — SyncClient, serialization helpers, protocol types
- **Tests**: `packages/quereus-sync-client/test/` — serialization.spec.ts, sync-client.spec.ts
- **Docs**: `packages/quereus-sync-client/README.md`

## Tests Added

Extended from 9 to 45 tests across 2 test files:

### serialization.spec.ts (12 tests, was 4)
- HLC round-trip: 1 existing test
- ChangeSet round-trip: column changes, delete changes, schema migrations (3 existing)
- HLC edge cases: counter 0, max counter (65535), wallTime 0, large wallTime (4 new)
- ChangeSet edge cases: empty set, multiple changes, null values, composite primary keys (4 new)

### sync-client.spec.ts (33 tests, was 5)

Created MockWebSocket class simulating full WebSocket API with `simulateOpen()`, `simulateMessage()`, `simulateClose()`, `simulateError()`, `getSentMessages()`. Enhanced MockSyncManager with call tracking.

- constructor: required options, optional configuration (2 tests)
- connect: WebSocket creation, status transitions, handshake sending, token in URL, error rejection, existing connection cleanup (6 tests)
- disconnect: clean when not connected, WebSocket close, status emission, sync event emission (4 tests)
- status tracking: initial disconnected, isConnected when open, isSynced after changes (3 tests)
- message handling: handshake ack → get_changes, apply remote changes, push_changes handling, onRemoteChanges callback, apply_result, error messages, pong, unknown types (8 tests)
- local change pushing: subscribe after handshake, no push when disconnected, no send on empty changes (3 tests)
- reconnection: no reconnect when autoReconnect false, no reconnect after intentional disconnect, reconnect with backoff (3 tests)
- sync events: state-change lifecycle, timestamps, remote-change details (3 tests)
- send guard: no send when WebSocket not open (1 test)

## Code Quality Fixes

### Fix 1: DRY — Extract maxHLCFromChangeSets helper
Duplicated max-HLC-finding loop in `handleChanges` and `pushLocalChanges` extracted into a shared `maxHLCFromChangeSets()` function.

**Location**: `sync-client.ts` top-level helper function

### Fix 2: Type Safety — send() parameter type
Changed `send(message: object)` to `send(message: ClientMessage)` to enforce protocol-correct messages at compile time.

**Location**: `sync-client.ts` `send()` method

### Fix 3: Type Safety — requestChangesFromServer cleanup
Replaced loose `{ type: string; sinceHLC?: string }` intermediate object with direct `GetChangesMessage`-compatible construction.

**Location**: `sync-client.ts` `requestChangesFromServer()` method

### Fix 4: README accuracy (3 corrections)
1. `syncEvents?: SyncEventEmitter` → `syncEvents: SyncEventEmitter` (required, not optional)
2. `getStatus(): SyncStatus` → `status: SyncStatus` getter property (+ added `isConnected`, `isSynced`)
3. `serializeHLC`/`deserializeHLC` → `serializeHLCForTransport`/`deserializeHLCFromTransport`

## Code Quality Observations

### Positive Findings
- Clean file separation: types.ts (pure types), serialization.ts (pure functions), sync-client.ts (stateful client)
- Proper resource cleanup in `disconnect()` (timers, listeners, WebSocket)
- `subscribeToLocalChanges()` correctly unsubscribes before re-subscribing
- Good use of exponential backoff for reconnection
- Well-documented with JSDoc throughout
- Cross-platform base64 helpers (browser btoa/atob + Node.js Buffer)
- Protocol message types are properly defined as discriminated unions

### Minor Notes (not fixed — acceptable as-is)
- `handleMessage` uses `JSON.parse(data)` without explicit try/catch, but errors are caught by the `.catch()` in `onmessage` handler
- `handleMessage` receives untyped parsed JSON; runtime type validation is not performed beyond the `switch` on `message.type`

## Files Modified

- `packages/quereus-sync-client/src/sync-client.ts` — DRY extraction, type safety improvements
- `packages/quereus-sync-client/test/serialization.spec.ts` — 8 new edge case tests
- `packages/quereus-sync-client/test/sync-client.spec.ts` — 28 new tests with MockWebSocket
- `packages/quereus-sync-client/README.md` — 3 accuracy corrections

## Test Validation

45 passing, 0 pending. Run with:
```bash
cd packages/quereus-sync-client && yarn test
```

