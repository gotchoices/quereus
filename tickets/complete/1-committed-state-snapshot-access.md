---
description: committed.tablename pseudo-schema for accessing pre-transaction state
prereq: MVCC layer system, schema-resolution, memory module
---

## Summary

The `committed.tablename` pseudo-schema provides read-only access to the pre-transaction (committed) state of tables, enabling transition constraints and assertions that compare current state against the committed baseline.

### Implementation

- **Schema resolution** (`planner/building/schema-resolution.ts`): `COMMITTED_SCHEMA` constant and `isCommittedSchemaRef()` helper; `resolveTableSchema()` intercepts `committed` pseudo-schema and resolves the real table via default search path.
- **Plan node** (`planner/nodes/reference.ts`): `TableReferenceNode.readCommitted` boolean flag flows through planning.
- **Table builder** (`planner/building/table.ts`): Detects `committed` schema qualifier and passes `readCommitted: true` to `TableReferenceNode`.
- **DML enforcement** (`planner/building/insert.ts`, `update.ts`, `delete.ts`): Early plan-time rejection of DML targeting `committed.*` tables.
- **Runtime emission** (`runtime/emit/scan.ts`): Merges `_readCommitted: true` into module connect options when `source.readCommitted` is true.
- **Memory module** (`vtab/memory/module.ts`, `table.ts`): Committed-snapshot `MemoryTable` creates unregistered connections (no `db.registerConnection()`, no `begin()`) that read from `conn.readLayer` (the committed layer), ignoring `pendingTransactionLayer`. `update()` throws on attempted modification.

### Design Decisions

- **Committed = transaction-start state**: Pinned to `currentCommittedLayer`, unaffected by savepoints.
- **Unregistered connections**: Prevents transaction lifecycle events from altering the committed snapshot.
- **Dual enforcement**: Read-only enforced at plan time (DML builders) and runtime (`MemoryTable.update()`).

### Testing

`packages/quereus/test/logic/42-committed-snapshot.sqllogic` — 9 test scenarios covering:
- Basic SELECT from committed state within/outside transactions
- Read-only enforcement (INSERT/UPDATE/DELETE errors)
- JOINs between current and committed state
- Multiple tables with committed references
- Savepoint interaction (committed state invariant across savepoints)
- Assertion integration (violation detection and passing cases)

### Validation

- Build passes
- All committed-snapshot tests pass
- README updated with committed pseudo-schema documentation
