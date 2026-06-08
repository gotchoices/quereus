---
description: Error handling improvements in sync-manager-impl.ts and change-applicator.ts
files:
  - packages/quereus-sync/src/sync/sync-manager-impl.ts
  - packages/quereus-sync/src/sync/change-applicator.ts
  - packages/quereus-sync/src/sync/store-adapter.ts
  - packages/quereus-sync/src/sync/sync-context.ts
  - packages/quereus-sync/test/sync/sync-manager.spec.ts
---

# SyncManager Error Handling — Complete

## Changes

1. **Missing PK warning** — `handleDataChange()` logs `console.warn` when primary key is absent instead of silently dropping the change.

2. **Try/catch on async event handlers** — `handleDataChange` and `handleSchemaChange` catch errors, log via `console.error`, and emit `SyncState` error events. They do not re-throw (fire-and-forget handlers).

3. **applyToStore failure handling** — Phase 2 of `applyChanges()` wraps the `applyToStore` callback in try/catch. On failure, emits error state and re-throws. CRDT metadata is not committed, allowing retry on next sync.

4. **Consistent conflict events** — `ConflictEvent` is emitted for both local-wins and remote-wins LWW outcomes, with `winner` field distinguishing them.

5. **Conditional table schema warning** — Warning only fires when `getTableSchema` callback was provided but returned undefined; no warning when fallback column names are expected.

6. **DRY: `toError()` helper** (review fix) — Extracted `toError(error: unknown): Error` into `sync-context.ts`, replacing 5 inline `error instanceof Error ? error : new Error(String(error))` patterns across sync-manager-impl, change-applicator, and store-adapter.

## Testing

8 tests in `sync-manager.spec.ts` `error handling` block. All 151 tests pass.
