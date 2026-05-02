description: Fixed ALTER COLUMN overlay data loss in isolation layer by migrating staged rows
files:
  packages/quereus-isolation/src/isolation-module.ts
  packages/quereus-store/test/isolated-store.spec.ts
  packages/quereus/test/logic.spec.ts
----

## What was built

`IsolationModule.alterTable` previously discarded all per-connection overlay rows when an ADD/DROP/RENAME/ALTER COLUMN operation mutated the underlying schema, silently losing uncommitted writes. The fix migrates overlay rows to a freshly-shaped overlay instead of dropping them.

Key behaviours, in `packages/quereus-isolation/src/isolation-module.ts`:

- `alterTable` collects all affected overlays before delegating to the underlying module, captures the pre-alter `dropColumnIdx` from the overlay schema (since the underlying alter mutates the schema), then rebuilds each overlay against the post-alter schema and reinserts rows.
- `migrateOverlayForAlter` (private) creates a new overlay table with `createOverlaySchema`, iterates the old overlay via a full-scan `FilterInfo`, translates each row, and re-inserts. Skips iteration when `hasChanges` is false.
- `translateOverlayRow` (private) preserves the tombstone column and remaps data columns:
  - `addColumn` → appends `null` (new column always at the end)
  - `dropColumn` → removes the dropped cell
  - `renameColumn` / `alterColumn` / `alterPrimaryKey` → data unchanged
  - `default` branch has an `_exhaustive: never` for future-proofing
- `makeFullScanFilterInfo` (private) builds a no-constraint full-scan `FilterInfo` for migration.

`41.2-alter-column.sqllogic` was removed from `MEMORY_ONLY_FILES` in `packages/quereus/test/logic.spec.ts`; it now passes in store mode.

`IsolatedTable.alterSchema` was intentionally left as-is — it clears the overlay because that path is the table-level DDL bypass; real `ALTER TABLE` statements go through `IsolationModule.alterTable` (verified at `packages/quereus/src/runtime/emit/alter-table.ts`).

## Testing

- `yarn test` — passes. Initial run hit a known-flaky property test (`Optimizer Equivalence — all rewrite rules disabled produces identical results`, seed -644300717); re-run cleared. Unrelated to overlay migration.
- `yarn test:store` — 2436 passing, 9 pending, 0 failing. `41.2-alter-column.sqllogic` confirmed green via `--reporter spec`. The `50-declarative-schema.sqllogic` failure noted in the review-stage handoff is no longer reproducing.
- `packages/quereus-store/test/isolated-store.spec.ts` adds an `ALTER TABLE overlay migration` describe block with 3 unit tests:
  - INSERT + ADD COLUMN → row survives with NULL in new column
  - INSERT + DROP COLUMN → row survives without dropped column
  - INSERT + RENAME COLUMN → row readable under the new column name

## Usage notes

The fix is automatic — any module wrapped by `IsolationModule` (currently the store module) now retains pending writes through ADD/DROP/RENAME/ALTER COLUMN operations within an open transaction.

Edge: `alterColumn` with `setDataType` does not coerce overlay rows to the new physical type during migration; staged rows pass through verbatim. Underlying conversion remains the underlying module's responsibility per the `SchemaChangeInfo` contract. Out of scope for this ticket (which addressed data loss); a separate ticket can track typed-coercion of overlay rows if the gap is observed.
