---
description: Comprehensive review of quereus-store package (KVStore, StoreModule, encoding, serialization, events)
prereq: [review-core-api, review-core-vtab]

---

# Store Package Review

## Goal

Adversarial review of the `@quereus/store` package: test from interface without implementation bias, inspect code quality, and ensure documentation accuracy.

## Scope

- **Source**: `packages/quereus-store/src/common/` — KVStore interfaces, InMemoryKVStore, StoreModule, StoreTable, StoreConnection, TransactionCoordinator, encoding, serialization, key-builder, events, ddl-generator, isolated-store
- **Tests**: `packages/quereus-store/test/` — encoding, serialization, isolated-store (pre-existing); memory-store, transaction, events, key-builder, ddl-generator (new)
- **Docs**: `packages/quereus-store/README.md`, `docs/store.md`

## Tests Added

Created 5 new test files with 88 interface-driven tests (129 total, up from 41):

### memory-store.spec.ts (25 tests + 1 pending)
- get/put/delete/has: 7 tests (missing key, overwrite, copy semantics)
- iterate: 9 tests + 1 skipped (bounds, reverse, limit, combined ranges)
- batch: 3 tests (put, delete, clear)
- close: 2 tests (throws on get/put after close)
- approximateCount: 2 tests (total count, range count)
- clear/size: 2 tests

### transaction.spec.ts (20 tests)
- begin/isInTransaction: 3 tests (initial state, enter, idempotent)
- put/delete outside transaction: 2 tests (throws)
- commit: 4 tests (writes ops, fires events, no-op when not in txn, callbacks)
- rollback: 4 tests (discards ops, discards events, no-op, callbacks)
- queueEvent outside transaction: 1 test (immediate emit)
- savepoints: 5 tests (create/release, rollback, events, nested, invalid depth)
- getStore: 1 test

### events.spec.ts (14 tests)
- Schema/data event subscription and unsubscription
- Multiple listeners, batching (start/flush/discard)
- Listener error handling (continues to other listeners)
- hasListeners/hasDataListeners/hasSchemaListeners
- removeAllListeners
- Remote event tracking (expect/clear/emit)

### key-builder.spec.ts (17 tests)
- Constants, store name builders (data, index, stats)
- Key builders (data, index, catalog, stats)
- Scan bounds (full scan, index prefix, catalog)

### ddl-generator.spec.ts (10 tests)
- generateTableDDL: single PK, composite PK, schema-qualified, temp, USING, nullable
- generateIndexDDL: simple, collation, DESC, schema-qualified

## Bugs Found (2)

### Bug 1: InMemoryKVStore reverse iteration with bounds returns empty

Upper-bound `break` logic in `iterate()` fires on the first (highest) entry in reverse order, returning 0 results instead of filtering correctly.

**Location**: `memory-store.ts` lines 82–96
**Test**: `memory-store.spec.ts` → `'supports reverse with bounds'` (`.skip`)
**Follow-up**: `tasks/fix/store-memory-reverse-iter-bug.md`

### Bug 2: Secondary index updates bypass TransactionCoordinator

`StoreTable.updateSecondaryIndexes()` applies index writes directly even when in a transaction, so index mutations are not rolled back on transaction rollback. Both `if/else` branches are identical (DRY violation).

**Location**: `store-table.ts` lines 589–611
**Follow-up**: `tasks/fix/store-index-transaction-bypass.md`

## Code Quality Observations

### Issues Noted (not fixed — follow-up tasks or pre-existing plan tasks)

- **scanPKRange full scan**: `store-table.ts` lines 368–377 does full scan with TODO to refine bounds. The `_access: PKAccessPattern` parameter is unused.
- **Deprecated key-builder exports**: `key-builder.ts` lines 187–243 has legacy exports awaiting consumer migration.
- **Global collation encoder registry**: `encoding.ts` uses a module-level singleton Map. Already tracked in `tasks/plan/collation-registry-per-database.md`.

### Positive Findings

- Clean interface/implementation separation (KVStore ↔ provider ↔ module)
- Good use of sort-preserving binary encoding with collation support
- TransactionCoordinator properly manages savepoints with depth tracking
- StoreEventEmitter correctly implements batching and remote event tracking
- WriteBatch pattern with clear() for discard is clean
- DDL generator produces correct SQL for all tested scenarios
- InMemoryKVStore stores copies to prevent external mutation (defensive)

## Documentation Review

- **README**: Up-to-date and accurate
- **docs/store.md**: Minor staleness — `DataChangeEvent` interface shows `key: SqlValue[]` as required, but actual interface has `key?: SqlValue[]` optional plus `pk?: SqlValue[]` alias, `changedColumns?: string[]`, and `remote?: boolean` fields

## Follow-Up Tasks Created

- `tasks/fix/store-memory-reverse-iter-bug.md` — Reverse iteration bounds bug with failing test
- `tasks/fix/store-index-transaction-bypass.md` — Index ops bypass coordinator + DRY violation

## Files Modified

- `packages/quereus-store/test/memory-store.spec.ts` — New (25 tests + 1 pending)
- `packages/quereus-store/test/transaction.spec.ts` — New (20 tests)
- `packages/quereus-store/test/events.spec.ts` — New (14 tests)
- `packages/quereus-store/test/key-builder.spec.ts` — New (17 tests)
- `packages/quereus-store/test/ddl-generator.spec.ts` — New (10 tests)

## Test Validation

129 passing, 1 pending (known bug marked `.skip`). Run with:
```bash
node --import ./packages/quereus-store/register.mjs node_modules/mocha/bin/mocha.js "packages/quereus-store/test/**/*.spec.ts" --colors
```

