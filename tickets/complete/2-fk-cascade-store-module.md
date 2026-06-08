description: FK `on delete cascade` leaves orphaned child rows when using the store-module (IndexedDB-backed) vtab
prereq:
files:
  packages/quereus-store/src/common/store-table.ts
  packages/quereus-store/test/fk-cascade.spec.ts
  packages/quereus/src/runtime/emit/dml-executor.ts
----

## Summary

Fixed a bug where `ON DELETE CASCADE` did not fire for store-backed (IndexedDB) virtual tables. The store module's `StoreTable.update()` delete path returned `{ status: 'ok' }` without the deleted row data. The DML executor in `dml-executor.ts` treats a missing `row` as "row not found, skip", so FK cascade actions and data change events were silently skipped.

## Fix

One-line change in `packages/quereus-store/src/common/store-table.ts` line 612:

```diff
- return { status: 'ok' };
+ return { status: 'ok', row: oldRow || undefined };
```

This aligns the store module's delete result with the memory vtab contract (`performDelete` in `packages/quereus/src/vtab/memory/layer/manager.ts`), which returns `{ status: 'ok', row: oldRowData }`.

## Tests

`packages/quereus-store/test/fk-cascade.spec.ts` — 4 tests:

- **removes child rows when parent is deleted** — basic cascade with 2 children
- **removes all child rows when all parents are deleted** — bulk parent delete
- **cascades through multiple levels** — parent → child → grandchild three-level cascade
- **emits data change events for cascaded child deletes** — verifies delete events fire for both child and parent rows

## Review Notes

- Return contract (`{ status: 'ok', row }`) is now consistent across all three DML operations (insert, update, delete) in `StoreTable.update()`
- The `oldRow || undefined` correctly maps null (row not found) to undefined, matching the DML executor's skip logic
- All tests pass: 165 store, 1917 core
- Build clean
