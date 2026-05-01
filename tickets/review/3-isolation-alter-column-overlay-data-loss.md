description: Review overlay migration fix for ALTER COLUMN data loss in isolation layer
prereq: none
files:
  packages/quereus-isolation/src/isolation-module.ts
  packages/quereus-store/test/isolated-store.spec.ts
  packages/quereus/test/logic.spec.ts
----

## What was built

`IsolationModule.alterTable` previously discarded all per-connection overlay rows when an ADD/DROP/RENAME/ALTER COLUMN operation mutated the underlying schema. This caused any pending (uncommitted) writes to disappear silently.

The fix migrates overlay rows to a freshly-shaped overlay instead of dropping them:

- **ADD COLUMN** — appends `null` to each overlay row's data columns (new column always goes at the end).
- **DROP COLUMN** — removes the dropped column cell from each overlay row; pre-alter column index is read from the overlay schema before the underlying alter runs.
- **RENAME / ALTER COLUMN** — data column indices are unchanged; rows are re-inserted verbatim into the new-schema overlay.

Three private helpers were added to `IsolationModule`:
- `migrateOverlayForAlter` — creates the new overlay, iterates old rows, delegates translation.
- `translateOverlayRow` — per-row column remapping.
- `makeFullScanFilterInfo` — produces a full-table-scan FilterInfo (matches `IsolatedTable.createFullScanFilterInfo`; could be extracted to a shared utility if both diverge further).

`41.2-alter-column.sqllogic` was removed from `MEMORY_ONLY_FILES`; it now passes in store mode.

## Testing

- `yarn test` — 100% pass.
- `yarn test:store` — 567 passing, 18 pending (one fewer than before; `41.2` now runs), 1 pre-existing failure in `50-declarative-schema.sqllogic` (deferred-constraint ambiguity, unrelated to this ticket).
- Three new unit tests in `packages/quereus-store/test/isolated-store.spec.ts` under "ALTER TABLE overlay migration":
  - INSERT + ADD COLUMN → row survives with NULL in new column.
  - INSERT + DROP COLUMN → row survives without the dropped column.
  - INSERT + RENAME COLUMN → row readable under the new column name.

## Review checklist

- [ ] `IsolationModule.alterTable` no longer deletes overlays; migrates them correctly for all `SchemaChangeInfo` variants.
- [ ] `migrateOverlayForAlter` skips row migration when `hasChanges` is false (fast path for empty overlays).
- [ ] `dropColumnIdx` is captured from the overlay schema **before** the underlying `alterTable` mutates the schema — correct ordering.
- [ ] `translateOverlayRow` handles the exhaustive `never` branch for future-proofing.
- [ ] All three new unit tests cover the right assertions (value presence, null-column, missing dropped column).
- [ ] `41.2-alter-column.sqllogic` removed from exclusion list and confirmed green in store mode.
- [ ] No impact on the `alterSchema` path on `IsolatedTable` (that path clears the overlay intentionally — it's the table-level DDL bypass, not the module-level ALTER TABLE path).
- [ ] Pre-existing `50-declarative-schema.sqllogic` failure is unrelated (deferred constraint ambiguity); assess whether it should be added to `MEMORY_ONLY_FILES`.
