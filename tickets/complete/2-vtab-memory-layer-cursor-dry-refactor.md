description: Deduplicated planAppliesToKey and scan logic across base-cursor, transaction-cursor, and manager
prereq: none
files:
  packages/quereus/src/vtab/memory/layer/plan-filter.ts (new)
  packages/quereus/src/vtab/memory/layer/scan-layer.ts (new)
  packages/quereus/src/vtab/memory/layer/interface.ts (modified)
  packages/quereus/src/vtab/memory/layer/manager.ts (modified)
  packages/quereus/src/vtab/memory/layer/base-cursor.ts (deleted)
  packages/quereus/src/vtab/memory/layer/transaction-cursor.ts (deleted)
----
## Summary

Extracted three near-identical implementations of `planAppliesToKey` (base-cursor closure, transaction-cursor closure, manager method) into a single shared utility in `plan-filter.ts`. Merged `scanBaseLayer` and `scanTransactionLayer` into a unified `scanLayer` generator in `scan-layer.ts` that operates on the `Layer` interface. Net reduction of ~265 lines.

Key improvements:
- Fixed null `equalityKey` handling: `!= null` guard correctly skips equality matching for both `null` and `undefined` (old code was inconsistent between cursors)
- Removed `any` casts from the old transaction-cursor's comparator resolution
- Gets `primaryTree` once before secondary index iteration loop (old code re-fetched per entry)
- Made `getSecondaryIndexTree` required on the `Layer` interface (both implementations already provided it)

## Review notes
- Build passes, all 1134 tests pass (1013 quereus + 121 workspace)
- No lint errors in changed files (5 pre-existing `any` warnings in unrelated catch blocks in manager.ts)
- No stale references to deleted files anywhere in codebase or docs
- Minor comment fix applied: replaced stale "// New method to abstract layer scanning" with a proper JSDoc

## Testing
- Null `equalityKey` edge case exercised by `41-foreign-keys.sqllogic` (SET NULL ON DELETE/UPDATE scenarios)
- Key test areas: FK cascades, index scans, range scans, prefix-range scans, DESC index scans, multi-seek, multi-range
