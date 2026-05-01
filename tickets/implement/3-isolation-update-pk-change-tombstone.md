description: UPDATE that changes the primary key inserts a new overlay row at the new PK but does not tombstone the old PK; both rows exist after merge
prereq: none
files:
  packages/quereus-isolation/src/isolated-table.ts
  packages/quereus/test/logic/41-fk-cross-schema.sqllogic
  packages/quereus/test/logic.spec.ts
----

## Root cause

`IsolatedTable.update(operation:'update', ...)` (`packages/quereus-isolation/src/isolated-table.ts:621-654`) handles the case where the overlay already has a row for `oldKeyValues` and writes the new row at the same overlay slot. When the UPDATE *changes* the PK, that path no longer applies — the new row needs to land at a different overlay key. The current code falls into the "insert new overlay row (shadows underlying)" branch (line 645-652), which does insert a row at the new PK, but does *not* leave a tombstone for the old PK.

Net result after merge: both the old row (from the underlying or pre-existing overlay) and the new row (inserted by the UPDATE) appear in scan results — duplicating the row across two PK values.

## Affected sqllogic

- `41-fk-cross-schema.sqllogic` — schema-qualified FK with PK retargeting.

## Fix approach

In `IsolatedTable.update(operation:'update')`:

- Detect a PK change by comparing `oldKeyValues` to the PK extracted from `values` (using `pkIndices`).
- When they differ:
  - First check for UNIQUE/PK conflict at the new PK (this overlaps with `isolation-cross-layer-unique-on-conflict` — coordinate so we don't double-implement; the new-PK check belongs there if landed first).
  - Write the new row at the new PK (overlay insert with `tombstone = 0`).
  - Write a tombstone at the old PK (so merge-iteration shadows the underlying row).
- Return the old row from the result so DML executor's auto-event path emits a single `update` event, not separate `delete`+`insert`.

## Validation

- New unit test in `packages/quereus-store/test/isolated-store.spec.ts`:
  - Underlying has `(1, 'A')`. In a transaction: `UPDATE t SET id = 2 WHERE id = 1`. Read inside transaction: rows are `[(2, 'A')]` (not `[(1, 'A'), (2, 'A')]`). After COMMIT, underlying has `[(2, 'A')]`. After ROLLBACK, underlying has `[(1, 'A')]`.
  - Same with composite PK.
- `yarn test:store -- --grep "41-fk-cross-schema"` passing.
- `yarn test` — no regressions.

## TODO

- In `IsolatedTable.update` `case 'update'`, detect PK change and emit tombstone at old PK alongside new row at new PK.
- Add the unit tests described above.
- Remove `41-fk-cross-schema.sqllogic` from `MEMORY_ONLY_FILES`.
- Run `yarn test`, `yarn test:store` and confirm green.
