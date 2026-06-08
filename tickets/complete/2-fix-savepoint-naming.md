---
description: Replace hash-based savepoint names with stack-based approach
prereq: none

status: complete
---

# Fix Savepoint Naming Collision Risk

## Problem

The savepoint implementation used a hash function to convert savepoint names to numeric indices, creating collision risk and no validation of savepoint existence.

## Solution Implemented

Replaced hash-based indices with a stack-based approach using actual savepoint names, centralized in `TransactionManager`.

### Architecture

- **TransactionManager** (`database-transaction.ts`): Maintains a `savepointStack: string[]` with name-based `createSavepoint()`, `findSavepoint()`, `releaseSavepoint()`, and `rollbackToSavepoint()` methods. Returns depth indices for connection coordination.
- **Emission layer** (`runtime/emit/transaction.ts`): Removed `hashSavepointName()`. All savepoint operations go through TransactionManager for name validation, then pass depth indices to connections.
- **VirtualTableConnection interface** (`vtab/connection.ts`): Retains `number` parameter (now depth index instead of hash). No breaking interface change.
- **MemoryTableConnection** (`vtab/memory/layer/connection.ts`): Converted from `Map<number, TransactionLayer>` to `savepointStack: TransactionLayer[]`. `ROLLBACK TO` preserves the savepoint (per SQL standard) by creating a fresh mutable layer inheriting from the snapshot.
- **StoreConnection / TransactionCoordinator** (`quereus-store`): Converted from `Map<number, Savepoint>` to `savepointStack: SavepointSnapshot[]`. Same stack semantics.
- **IsolatedConnection** (`quereus-isolation`): Passes depth indices through transparently; no changes needed.

### Key Behaviors

- `SAVEPOINT name` — pushes name onto stack, creates change/event layers, returns depth index
- `ROLLBACK TO SAVEPOINT name` — validates name exists, rolls back layers above target (inclusive), re-creates a fresh layer (savepoint is preserved per SQL standard)
- `RELEASE SAVEPOINT name` — validates name exists, merges layers from target to top into parent
- Non-existent savepoint names throw `QuereusError` with `StatusCode.ERROR`

### Files Changed

- `packages/quereus/src/core/database-transaction.ts` — Added savepoint stack and name-based methods
- `packages/quereus/src/core/database.ts` — Updated internal API methods
- `packages/quereus/src/runtime/emit/transaction.ts` — Removed hash, uses TransactionManager
- `packages/quereus/src/vtab/memory/layer/connection.ts` — Stack-based savepoints
- `packages/quereus/src/vtab/memory/connection.ts` — Pass-through (no changes)
- `packages/quereus/src/vtab/connection.ts` — Interface unchanged (still `number`)
- `packages/quereus-store/src/common/transaction.ts` — Stack-based savepoints
- `packages/quereus/test/logic/04-transactions.sqllogic` — Added comprehensive tests
- `packages/quereus/test/memory-vtable.spec.ts` — Updated to use depth-based indices

### Tests Added (04-transactions.sqllogic)

- Nested savepoints (s1 → s2 → ROLLBACK TO s1 discards s2)
- ROLLBACK TO non-existent savepoint (errors)
- RELEASE non-existent savepoint (errors)
- Same-prefix savepoint names (sp vs spa — no collision)
- ROLLBACK TO preserves savepoint (can release after rollback)
- Deep nested savepoints unwinding correctly (sp_outer → sp_middle → sp_inner)
