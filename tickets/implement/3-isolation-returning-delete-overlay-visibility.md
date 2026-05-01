description: DELETE … RETURNING and DELETE-as-subquery composite DML do not observe overlay rows when merged through the isolation layer
prereq: none
files:
  packages/quereus-isolation/src/isolated-table.ts
  packages/quereus-isolation/src/merge-iterator.ts
  packages/quereus/src/runtime/emit/dml-executor.ts
  packages/quereus/test/logic/42-returning.sqllogic
  packages/quereus/test/logic/44-orthogonality.sqllogic
  packages/quereus/test/logic.spec.ts
----

## Root cause (suspected — needs trace)

`DELETE … RETURNING` and DML statements that read back their own writes (`44-orthogonality.sqllogic`) flow through a path that opens a fresh cursor over the table to capture the deleted rows. Through the isolation layer, that cursor may:

- Read only from the underlying (skipping overlay tombstones / overlay inserts) — so RETURNING omits rows that exist only in the overlay or includes rows that the overlay has tombstoned.
- Read only from the overlay (in `_readCommitted`-style fast paths) — same problem in reverse.

The DML executor's read-then-write loop is the most common shape: enumerate matching rows for DELETE, capture their values for RETURNING, then issue a `delete` per row. If enumerate goes underlying-only and the row was only in the overlay, the delete is a no-op and RETURNING is empty.

## Affected sqllogic

- `42-returning.sqllogic` — `DELETE … RETURNING *` against rows written earlier in the same transaction.
- `44-orthogonality.sqllogic` — composite DML (`INSERT … SELECT FROM (DELETE …)` shapes) that observes its own writes.

## Fix approach

1. Capture which path RETURNING uses today — likely `IsolatedTable.query(...)` already merges overlay+underlying. Confirm whether the DML executor opens its enumeration via the wrapped `IsolatedTable` or against `state.underlyingTable` directly.
2. If the DML executor bypasses the wrapper for RETURNING enumeration: route it through the wrapper.
3. If it uses the wrapper but the merge does not include overlay rows in this specific shape: examine `merge-iterator.ts` for any code path that filters by tombstone before checking overlay-only rows; ensure overlay-only rows (no underlying) flow through.
4. Add the same trace for DELETE-as-subquery shapes — likely a similar fix.

## Validation

- New unit tests in `packages/quereus-store/test/isolated-store.spec.ts`:
  - In a transaction: INSERT 3 rows, then `DELETE … RETURNING *` → returns 3 rows.
  - In a transaction: INSERT 3 rows, then `DELETE WHERE id IN (SELECT id FROM (DELETE FROM other RETURNING id))` → behaves as memory mode does.
- `yarn test:store -- --grep "42-returning|44-orthogonality"` passing.
- `yarn test` — no regressions.

## TODO

- Trace the DML executor enumeration path for `RETURNING` against an overlaid table.
- Confirm whether the bug is in the executor (bypassing the wrapper) or the merge iterator (overlay-only rows missing).
- Apply the fix in the right layer; do not duplicate merge logic in the executor.
- Add the two unit tests above.
- Remove `42-returning.sqllogic` and `44-orthogonality.sqllogic` from `MEMORY_ONLY_FILES`.
- Run `yarn test`, `yarn test:store` and confirm green.
