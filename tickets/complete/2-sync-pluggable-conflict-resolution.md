description: Pluggable conflict resolution strategy for quereus-sync with column-level LWW default
files:
  - packages/quereus-sync/src/sync/protocol.ts (ConflictContext, ConflictResolution, ConflictResolver types; conflictResolver on SyncConfig)
  - packages/quereus-sync/src/sync/conflict-resolvers.ts (lwwResolver, localWinsResolver, remoteWinsResolver)
  - packages/quereus-sync/src/sync/change-applicator.ts (unified resolveChange path)
  - packages/quereus-sync/src/sync/events.ts (ConflictEvent with schema field)
  - packages/quereus-sync/src/index.ts (exports)
  - packages/quereus-sync/test/sync/conflict-resolvers.spec.ts (8 E2E tests)
  - docs/sync.md (pluggable conflict resolution docs)
----

## What was built

Optional `conflictResolver` field on `SyncConfig` for custom column-level conflict strategies. Three built-in resolvers exported: `lwwResolver`, `localWinsResolver`, `remoteWinsResolver`. When no resolver is configured, the default HLC comparison (LWW) fires directly.

## Review fixes applied

- **DRY refactor in change-applicator.ts**: Unified the custom-resolver path and the fast path into a single code path. Both branches were ~80 lines each with ~28 lines duplicated (tombstone check, conflict event emission, return structure). The old fast path also redundantly called `getColumnVersion` twice (once inside `shouldApplyWrite`, once explicitly). The unified path does a single `getColumnVersion` read, then branches only on the decision logic (resolver vs inline HLC comparison).
- **docs/sync.md**: Added missing `schema` field to the `ConflictEvent` interface example.
- **events.ts JSDoc**: Updated `onConflictResolved` comment from "via LWW" to "via LWW or a custom resolver."

## Testing

8 E2E tests via two-replica sync in `conflict-resolvers.spec.ts`:
- Default LWW preserved (no resolver)
- `localWinsResolver`: local kept even with lower HLC
- `remoteWinsResolver`: remote accepted even with lower HLC
- Custom field-level policy (different strategy per column)
- Resolver receives correct `ConflictContext` fields (spy)
- No local version -> resolver not called, remote applied directly
- Tombstone blocking works regardless of resolver
- `lwwResolver` matches default fast path
- `ConflictEvent` includes `schema` field

All 163 tests pass. Build clean.

## Usage

```typescript
import { createSyncModule, localWinsResolver } from '@quereus/sync';
import type { ConflictResolver } from '@quereus/sync';

// Built-in resolver
const { syncManager } = await createSyncModule(kv, storeEvents, {
  conflictResolver: localWinsResolver,
});

// Custom resolver
const resolver: ConflictResolver = (ctx) => {
  if (ctx.column === 'counter') return 'remote';
  return 'local';
};
const { syncManager } = await createSyncModule(kv, storeEvents, {
  conflictResolver: resolver,
});
```
