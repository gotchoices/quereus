description: Multi-row CASCADE DELETE through the isolation overlay leaves child rows behind; transition-constraint row counts diverge across overlay/underlying merge
prereq: none
files:
  packages/quereus-isolation/src/isolated-table.ts
  packages/quereus-isolation/src/merge-iterator.ts
  packages/quereus/src/runtime/emit/dml-executor.ts
  packages/quereus/test/logic/29-constraint-edge-cases.sqllogic
  packages/quereus/test/logic/43-transition-constraints.sqllogic
  packages/quereus/test/logic.spec.ts
----

## Root cause (suspected — needs confirmation)

CASCADE DELETE expansion enumerates child rows by querying the child table for matching FK values, then issues `DELETE` against each match. Through the isolation layer, the child's reads merge overlay+underlying, but the deletion path may:

- Issue `DELETE` only against rows visible in *one* layer (e.g. tombstones overlay rows, but does not write tombstones for underlying rows), or
- Skip rows whose visibility flips during the cascade (an overlay tombstone can shadow an underlying row that the cascade scan still saw).

Transition-constraint scenarios (`43-transition-constraints.sqllogic`) are sensitive to OLD/NEW row counts in the constraint statement — the merge iteration may report a row count that disagrees with the row count actually mutated, breaking the constraint.

## Affected sqllogic

- `29-constraint-edge-cases.sqllogic` — multi-row FK CASCADE DELETE through isolation.
- `43-transition-constraints.sqllogic` — `OLD TABLE` / `NEW TABLE` row counts after a multi-row mutation.

## Fix approach

This one needs investigation before a code-level fix is locked in. Suggested order of work:

1. Reproduce 29 and 43 individually under `yarn test:store -- --grep` and capture exact row-count expectations vs actual.
2. Trace one CASCADE DELETE batch through `IsolatedTable.update(operation:'delete')` to confirm whether each child row gets a tombstone write (it should — `packages/quereus-isolation/src/isolated-table.ts:656-720` writes a tombstone per delete).
3. If tombstones are written but a downstream read still sees the row, the bug is in the merge iteration during the cascade — probably the snapshot the cascade started with predates the tombstones it just wrote.
4. If tombstones are *not* written, the gap is at the DML executor — it may be calling underlying `delete` directly on `state.underlyingTable` for cascaded rows instead of going through the wrapped `IsolatedTable`.

Likely fix: ensure the cascade child-row enumeration uses the same `VirtualTable` instance that the rest of the transaction uses (so tombstones written by earlier iterations are visible to later iterations).

## Validation

- New unit test: parent with N children, CASCADE DELETE the parent inside a transaction, COMMIT, count children remaining = 0; rollback case → count = N.
- New unit test for transition: transition constraint counts OLD rows after a multi-row mutation through the overlay.
- `yarn test:store -- --grep "29-constraint-edge-cases|43-transition-constraints"` → both files passing.
- `yarn test` (memory mode) — no regressions.

## TODO

- Reproduce both files under store mode; capture exact diffs.
- Trace CASCADE DELETE through `IsolatedTable` to confirm tombstone write path and merge visibility during enumeration.
- Apply the fix (likely: route cascade child enumeration through the wrapped IsolatedTable; or carry tombstones in the cascade snapshot).
- Add the two unit tests described above.
- Remove `29-constraint-edge-cases.sqllogic` and `43-transition-constraints.sqllogic` from `MEMORY_ONLY_FILES`.
- Run `yarn test`, `yarn test:store` and confirm green.
