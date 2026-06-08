---
description: Fix hasChanges() to not misdetect inherited BTree entries
prereq: none
---

# Fix hasChanges() Inherited Entry Detection

## Summary

Replaced unreliable `getCount()` checks (which include inherited BTree entries) with a `_hasModifications` boolean flag set on mutation. This eliminates false positives where a transaction layer would report changes when it actually inherited all entries from its parent.

## Changes

- `packages/quereus/src/vtab/memory/layer/transaction.ts`:
  - Added `_hasModifications` flag, initialized to `false`
  - Set to `true` at the top of `recordUpsert()` and `recordDelete()`
  - `hasChanges()` now simply returns `_hasModifications`
  - `copyChangeTrackingFrom()` now also copies `_hasModifications` from the source layer

## Testing

Five unit tests added to `packages/quereus/test/memory-vtable.spec.ts` in the `TransactionLayer.hasChanges()` describe block:

- Fresh layer with no modifications returns false
- Fresh layer over a non-empty base returns false (the key bug scenario)
- Layer after upsert returns true
- Layer after delete returns true
- Nested layers: inner modified, outer returns false

All 243 Mocha tests and 49 node tests pass.

## Validation

The fix is used by `LayerManager.commitTransaction()` to guard against committing to a read-only table when there are no actual changes. Before this fix, opening a transaction against a table with existing data could falsely trigger the read-only error.
