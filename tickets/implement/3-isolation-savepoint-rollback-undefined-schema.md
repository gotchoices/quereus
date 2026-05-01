description: ROLLBACK TO SAVEPOINT through the overlay's MemoryVirtualTableConnection hits a TransactionLayer constructor with undefined schema
prereq: none
files:
  packages/quereus-isolation/src/isolated-connection.ts
  packages/quereus/src/vtab/memory/layer/transaction.js
  packages/quereus/src/vtab/memory/connection.ts
  packages/quereus/test/logic/101-transaction-edge-cases.sqllogic
  packages/quereus/test/logic.spec.ts
----

## Root cause

`IsolatedConnection.rollbackToSavepoint` (`packages/quereus-isolation/src/isolated-connection.ts:87-92`) forwards to both the overlay and underlying connections:

```ts
async rollbackToSavepoint(index: number): Promise<void> {
  await this.overlayConnection?.rollbackToSavepoint(index);
  await this.underlyingConnection?.rollbackToSavepoint(index);
}
```

When the overlay's `MemoryVirtualTableConnection.rollbackToSavepoint` reconstructs its layer stack, it instantiates a `TransactionLayer` with `undefined` for the schema — likely because the savepoint at `index` predates any overlay write (savepoint created before first INSERT/UPDATE in the transaction), so no schema snapshot was associated with that depth.

This overlaps with the savepoint fixes already landed in `complete/2-isolation-overlay-bugs` (which introduced `savepointsBeforeOverlay` to handle pre-overlay savepoints in `IsolatedTable`), but the connection-level path appears to bypass that guard.

## Affected sqllogic

- `101-transaction-edge-cases.sqllogic` — savepoint scenarios that rollback to a depth created before any overlay write.

## Fix approach

1. Reproduce in a unit test: open a transaction, `SAVEPOINT sp1`, INSERT a row, `ROLLBACK TO sp1` — confirm the failure mode.
2. In `IsolatedConnection.rollbackToSavepoint`, gate the `overlayConnection?.rollbackToSavepoint(index)` call on whether `index` is a depth at which the overlay was already alive. Reuse `IsolatedTable.savepointsBeforeOverlay` semantics — likely promote the set up to the connection level so it covers cross-table state.
3. If the savepoint is pre-overlay, clear the overlay outright instead of replaying through `MemoryVirtualTableConnection.rollbackToSavepoint`.
4. As a defensive measure, fix `TransactionLayer` to validate its schema arg at construction (throw a clear error rather than going into an undefined state) — but the real fix is at the IsolatedConnection level.

## Validation

- New unit test: `BEGIN; SAVEPOINT sp1; INSERT …; ROLLBACK TO sp1; SELECT …` → empty result; underlying unchanged after final ROLLBACK.
- New unit test: same but with two nested savepoints (sp1 pre-overlay, sp2 post-INSERT) — ROLLBACK to sp2 keeps the rest, ROLLBACK to sp1 wipes everything.
- `yarn test:store -- --grep "101-transaction-edge-cases"` passing.
- `yarn test` — no regressions.

## TODO

- Reproduce the failure in a unit test.
- Promote `savepointsBeforeOverlay` to connection scope (or otherwise gate the overlay rollback when the savepoint pre-dates the overlay).
- Defensive: validate schema arg in the `TransactionLayer` constructor.
- Add the two unit tests above.
- Remove `101-transaction-edge-cases.sqllogic` from `MEMORY_ONLY_FILES`.
- Run `yarn test`, `yarn test:store` and confirm green.
