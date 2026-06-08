description: INSERT OR REPLACE now emits correct 'update' change type when replacing an existing row
prereq: none
files:
  - packages/quereus/src/common/types.ts (UpdateResult — added optional `replacedRow` field)
  - packages/quereus/src/runtime/emit/dml-executor.ts (runInsert — checks replacedRow, emits 'update' with oldRow/changedColumns)
  - packages/quereus/src/vtab/memory/layer/manager.ts (performInsert — returns replacedRow on REPLACE)
  - packages/quereus-store/src/common/store-table.ts (insert case — emits 'update' event when replacing, returns replacedRow)
  - packages/quereus/test/database-events.spec.ts (4 new INSERT OR REPLACE tests)
  - packages/quereus/test/vtab-events.spec.ts (3 new INSERT OR REPLACE tests)
----

## Summary

Fixed two code paths that incorrectly emitted `type: 'insert'` instead of `type: 'update'` when `INSERT OR REPLACE` replaced an existing row:

1. **DML executor auto-emit path**: `runInsert()` now checks `result.replacedRow` and branches to emit 'update' with proper `oldRow`, `newRow`, and `changedColumns`.
2. **quereus-store native event path**: `store-table.ts` insert case now deserializes the existing row before overwrite, emits 'update' when replacing, and returns `replacedRow`. Also fixed secondary index cleanup on REPLACE (was passing `null` for old row).

## Key design decision

Extended `UpdateResult` ok variant with optional `replacedRow?: Row` — backwards-compatible signal from vtab to executor. Vtabs that don't return it continue to work as fresh inserts.

## Testing

7 tests across two files covering both auto-emit and native event paths:
- Replace existing row → 'update' with correct oldRow/newRow/changedColumns
- Insert new row via INSERT OR REPLACE → 'insert'
- Partial column changes → changedColumns only includes actually-changed columns
- Transaction batching → events deferred until commit

All 281 tests pass (1 pre-existing failure in 08.1-semi-anti-join.sqllogic, unrelated). Build clean.

## Review notes

- `changedColumns` computation uses `sqlValuesEqual` in auto-emit path (handles BLOBs/JSON), vs `!==` in memory vtab native path (`computeChangedColumns`). The `!==` usage is pre-existing, not introduced here.
- Store-table REPLACE path now properly passes `oldRow` to `updateSecondaryIndexes` — previously passed `null`, which would leave stale index entries on REPLACE.
