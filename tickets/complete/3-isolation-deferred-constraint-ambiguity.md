description: IsolatedConnection.isCovering tiebreak fixes deferred constraint "multiple candidate connections" error
files:
  packages/quereus/src/vtab/connection.ts
  packages/quereus-isolation/src/isolated-connection.ts
  packages/quereus-isolation/src/isolated-table.ts
  packages/quereus/src/runtime/deferred-constraint-queue.ts
  packages/quereus/test/logic.spec.ts
  packages/quereus-store/test/isolated-store.spec.ts
  docs/plugins.md
----

## Summary

Fixed `DeferredConstraintQueue.findConnection` throwing "multiple candidate connections" when the
isolation layer wraps a table. The runtime's `getVTable()` creates a fresh `IsolatedTable` per DML
statement; without reuse logic, every statement registered a new `IsolatedConnection` (qualified
with `"main.<table>"`) alongside the underlying `StoreConnection` (simple `"<table>"`). When a
deferred constraint (e.g. CHECK with EXISTS subquery) fired at COMMIT and `findConnection` had to
fall through to table-name matching, multiple candidates collided and an INTERNAL error masked the
real constraint failure.

## What changed

- **`packages/quereus/src/vtab/connection.ts`** — Added optional `readonly isCovering?: boolean` to
  `VirtualTableConnection`. Marks the canonical connection that coordinates all transaction
  semantics for the table (typically a wrapper sitting above a storage connection).
- **`packages/quereus-isolation/src/isolated-connection.ts`** — Sets `isCovering = true` on
  `IsolatedConnection`.
- **`packages/quereus/src/runtime/deferred-constraint-queue.ts`** — `findConnection` tiebreak: when
  multiple candidates match a table name, prefer the single `isCovering` connection. If exactly one
  covering connection exists, return it; otherwise throw the existing ambiguity error.
- **`packages/quereus-isolation/src/isolated-table.ts`** —
  - `ensureConnection()`: before creating a new `IsolatedConnection`, checks
    `getConnectionsForTable(qualifiedName)` for an existing covering connection and reuses it. This
    prevents one `IsolatedConnection` per statement.
  - `ensureConnection()` / `createConnection()` / `createConnectionAsync()`: `IsolatedConnection`
    now uses the qualified name (`schemaName.tableName`) instead of the simple name. This lets
    `removeConnectionsForTable` (called on DROP TABLE) correctly remove the IsolatedConnection,
    preventing stale callbacks across drop/re-create cycles.
  - INSERT case: when a live (non-tombstone) overlay row already exists for the PK and `onConflict`
    is ABORT, return the constraint error using the actual table name rather than the overlay's
    internal `_overlay_<name>_N` name. Fixes the `90-error_paths.sqllogic` PK error message leak.
- **`packages/quereus/test/logic.spec.ts`** — Removed `40-constraints.sqllogic` from
  `MEMORY_ONLY_FILES` (now passes in store mode). Updated comment for `41-foreign-keys.sqllogic`
  with the actual remaining reason (separate FK CASCADE bug, tracked in
  `3-store-fk-check-false-positive`).
- **`packages/quereus-store/test/isolated-store.spec.ts`** — Added `deferred CHECK constraints via
  IsolatedConnection` describe block with two tests: (1) deferred FK-style CHECK violation at
  COMMIT surfaces the constraint error, not "multiple candidate"; (2) deferred CHECK passes when
  the violation is fixed before COMMIT.
- **`docs/plugins.md`** — Documented the new optional `isCovering?` field on
  `VirtualTableConnection`.

## Test results

- `yarn test` (memory mode): **2443 passing**, 2 pending
- `yarn workspace @quereus/quereus run lint`: 0 errors (warnings only)
- `yarn workspace @quereus/store run test`: **244 passing** (includes 2 new deferred-CHECK tests)
- `yarn workspace @quereus/isolation run test`: **62 passing**
- Store mode (`logic.spec.ts` only, full pass): **109 passing**, 7 pending — including the
  previously-excluded `40-constraints.sqllogic` and the `90-error_paths.sqllogic` PK message check.
- `yarn test:store` separately bailed on a flaky fast-check optimizer property test
  (`Optimizer Equivalence > all rewrite rules disabled`, seed 1202577866) involving a `lead` window
  function with a correlated `IN` subquery — pre-existing and unrelated to this fix.

## Usage notes

- For module authors: set `readonly isCovering = true` on connection wrappers that sit above another
  storage connection (isolation layers, sync layers) so `findConnection` can disambiguate when both
  wrapper and underlying connections appear in the registry. Plain storage connections should leave
  `isCovering` unset (or `false`).
- The qualified-name change to `IsolatedConnection.tableName` means `removeConnectionsForTable` now
  correctly cleans up isolation wrappers on `DROP TABLE`, so re-creating a same-named table starts
  with a fresh IC and no stale callbacks.
