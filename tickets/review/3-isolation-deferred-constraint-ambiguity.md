description: Review implementation of IsolatedConnection.isCovering tiebreak for deferred constraint ambiguity
files:
  packages/quereus/src/vtab/connection.ts
  packages/quereus-isolation/src/isolated-connection.ts
  packages/quereus-isolation/src/isolated-table.ts
  packages/quereus/src/runtime/deferred-constraint-queue.ts
  packages/quereus/test/logic.spec.ts
  packages/quereus-store/test/isolated-store.spec.ts
----

## What was built

Fixed `DeferredConstraintQueue.findConnection` throwing "multiple candidate connections" when the isolation
layer wraps a table, because multiple `IsolatedConnection` objects accumulated in the database's connection
registry for the same table.

### Root cause

`IsolatedTable.ensureConnection()` is per-instance, but `IsolationModule.connect()` creates a fresh
`IsolatedTable` per `getVTable()` call (once per DML statement). Without reuse logic, every statement
registered a new `IsolatedConnection` (tableName="inventory" or similar) alongside the underlying store's
`StoreConnection` (tableName="inventory" too). `findConnection` saw N>1 matches and threw.

### Changes

**`packages/quereus/src/vtab/connection.ts`**
- Added optional `readonly isCovering?: boolean` to `VirtualTableConnection` interface — marks the
  canonical connection that covers all transaction semantics for the table.

**`packages/quereus-isolation/src/isolated-connection.ts`**
- Set `readonly isCovering = true` — marks IsolatedConnection as the covering connection.

**`packages/quereus/src/runtime/deferred-constraint-queue.ts`**
- `findConnection`: when multiple candidates match the table name, prefer the one with `isCovering=true`.
  If exactly one covering connection exists, return it; otherwise throw the existing ambiguity error.

**`packages/quereus-isolation/src/isolated-table.ts`** (primary fix)
- `ensureConnection()`: before creating a new IsolatedConnection, checks `getConnectionsForTable()` for
  an existing covering connection and reuses it. This prevents one IsolatedConnection per statement.
- `ensureConnection()` / `createConnection()` / `createConnectionAsync()`: IsolatedConnection now uses
  the qualified name (`schemaName.tableName`) instead of the simple name. This lets `removeConnectionsForTable`
  (called on DROP TABLE) correctly remove the IsolatedConnection, preventing stale callbacks across
  table drop/re-create cycles.
- INSERT case: when a live (non-tombstone) overlay row already exists for the PK and `onConflict` is
  ABORT, return the constraint error using the actual table name rather than the overlay's internal name
  (`_overlay_tableName_N`). Fixes `90-error_paths.sqllogic` PK error message leak.

**`packages/quereus/test/logic.spec.ts`**
- Removed `40-constraints.sqllogic` from `MEMORY_ONLY_FILES` — now passes in store mode.
- Updated comment for `41-foreign-keys.sqllogic` — remains excluded, but with the actual remaining reason:
  INSERT OR REPLACE CASCADE DELETE doesn't fire when the conflicting row is only in the underlying store
  (not yet in the overlay).

**`packages/quereus-store/test/isolated-store.spec.ts`**
- Added `deferred CHECK constraints via IsolatedConnection` describe block with two tests:
  1. Deferred FK-style CHECK violation at COMMIT surfaces the constraint error, not "multiple candidate"
  2. Deferred CHECK passes when the violation is fixed before COMMIT

## Test results

- `yarn test` (memory mode): **2443 passing**, 2 pending
- `yarn test:store` (store/LevelDB mode): **2427 passing**, 18 pending
- `yarn workspace @quereus/store run test`: **238 passing**
- `yarn workspace @quereus/isolation run test`: **60 passing**

## Use cases to validate

1. **Deferred CHECK with correlated subquery** (`40-constraints.sqllogic`):
   ```sql
   BEGIN;
   INSERT INTO dependent (id, ref_id) VALUES (100, 'missing');
   COMMIT;
   -- should throw: CHECK constraint failed: ref_must_exist
   ```
   Passes in store mode.

2. **Deferred CHECK that resolves before COMMIT**:
   ```sql
   BEGIN;
   INSERT INTO dependent (id, ref_id) VALUES (101, 'later');
   INSERT INTO ref_table VALUES ('later', 'OK');
   COMMIT;
   -- should succeed
   ```

3. **Table drop/re-create**: IC is removed from the connection registry on DROP TABLE (qualified name
   match in `removeConnectionsForTable`), so re-creating the table starts with a fresh IC.

4. **PK conflict error message** (`90-error_paths.sqllogic`): duplicate INSERT within a transaction
   now reports `UNIQUE constraint failed: t_pk PK.` rather than the overlay's internal name.

## Remaining MEMORY_ONLY_FILES

`41-foreign-keys.sqllogic` remains excluded — separate pre-existing bug: `IsolatedTable.update()` for
INSERT (onConflict=REPLACE) when the PK exists only in the underlying store returns no `replacedRow`,
so `executeForeignKeyActions` never fires the CASCADE DELETE. Tracked in plan ticket
`3-store-fk-check-false-positive`.
