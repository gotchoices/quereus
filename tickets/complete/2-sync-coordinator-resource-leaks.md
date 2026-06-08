---
description: Fix resource management bugs in sync-coordinator (eviction race, socket close leaks, cleanup/shutdown race)
prereq: none
files:
  - packages/sync-coordinator/src/service/store-manager.ts
  - packages/sync-coordinator/src/server/websocket.ts
  - packages/sync-coordinator/test/store-manager.spec.ts
---

# Resource Management Bug Fixes — Complete

## Changes

### 1. Store Eviction Race Condition (store-manager.ts)
`closeStore()` re-checks `entry.refCount > 0` before closing, guarding against re-acquisition between eviction selection and close across `await` boundaries.

### 2. Socket Close During Handshake (websocket.ts)
`socketClosed` flag tracked by the close handler. After `registerSession()`, `handleHandshake()` checks this flag and calls `unregisterSession()` if the socket closed during async registration — preventing a leaked store reference.

### 3. Handshake Error Cleanup (websocket.ts)
Catch block checks if `session` was assigned (i.e., `registerSession()` succeeded) and calls `unregisterSession()` before closing. Prevents leaked store reference when `getSiteId()` or `sendMessage()` throws after registration.

### 4. Cleanup Interval Race With Shutdown (store-manager.ts)
`_shuttingDown` flag set at start of `shutdown()`, checked at start of `cleanup()`. Prevents cleanup from iterating the stores map while shutdown concurrently closes and clears it.

## Testing

- "should not evict a store that was re-acquired before close" — verifies refCount guard
- "should close idle stores past timeout" — verifies cleanup for idle stores
- "should not close stores with active references" — verifies cleanup respects refCount
- "should not run cleanup after shutdown begins" — verifies shutdown/cleanup coordination
- All 103 tests pass, build clean

## Review Notes

- All fixes are minimal and correctly targeted at TOCTOU / async timing races
- No DRY violations or unnecessary complexity
- WebSocket race conditions (socketClosed, post-registration error) are defensive guards not practical to test without fragile timing mocks — acceptable
- `stores.delete()` inside try block of `closeStore()` correctly keeps failed-close entries tracked
