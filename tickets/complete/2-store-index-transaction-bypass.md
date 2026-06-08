---
description: Secondary index operations now route through TransactionCoordinator during transactions
prereq: packages/quereus-store/src/common/transaction.ts, packages/quereus-store/src/common/store-table.ts
files:
  - packages/quereus-store/src/common/transaction.ts
  - packages/quereus-store/src/common/store-table.ts
  - packages/quereus-store/test/transaction.spec.ts
---

# Complete: Secondary Index Updates Bypass TransactionCoordinator

## Summary

Secondary index writes in `StoreTable.updateSecondaryIndexes()` were applied directly to the index store during transactions, bypassing the `TransactionCoordinator`. Index mutations were not rolled back on transaction rollback, causing data/index inconsistency.

## Changes

- `TransactionCoordinator.put()`/`delete()` accept optional `store?: KVStore` to target stores other than the default
- `PendingOp` carries optional `store` field; `commit()` groups ops by target store and writes a batch per store
- `StoreTable.updateSecondaryIndexes()` routes through the coordinator with the index store when in a transaction

## Verification

- 4 new unit tests in `transaction.spec.ts` (multi-store commit, rollback, delete, savepoint rollback)
- Build and all 134 tests pass
- Code review: clean, minimal API extension, no DRY violations, proper interface-level testing
