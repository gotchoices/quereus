description: ALTER COLUMN through the isolation layer rebuilds the overlay schema and discards pending writes that have not yet been flushed
prereq: none
files:
  packages/quereus-isolation/src/isolation-module.ts
  packages/quereus-isolation/src/isolated-table.ts
  packages/quereus/test/logic/41.2-alter-column.sqllogic
  packages/quereus/test/logic.spec.ts
----

## Root cause

`IsolationModule.alterTable` (`packages/quereus-isolation/src/isolation-module.ts:295-321`) invalidates per-connection overlays after an ADD/DROP/RENAME column on the underlying schema:

```ts
const suffix = `:${schemaName}.${tableName}`.toLowerCase();
for (const key of [...this.connectionOverlays.keys()]) {
  if (key.endsWith(suffix)) {
    this.connectionOverlays.delete(key);
  }
}
```

That deletion drops *any* pending writes the connection had staged in the overlay. The shape change is necessary (overlay schema must match new underlying schema), but data loss is not — pending rows should be migrated to a freshly-shaped overlay.

ALTER inside a transaction is unusual but legal in SQLite-style semantics; this path also fires during DDL bootstrapping where pending writes from declarative-schema seed flows could be in-flight.

## Affected sqllogic

- `41.2-alter-column.sqllogic` — ALTER COLUMN on a table with pending overlay writes.

## Fix approach

In `IsolationModule.alterTable`:

- For each affected per-connection overlay state:
  - Snapshot all overlay rows (via `overlayTable.query(fullScan)`).
  - Materialize a new overlay using the post-alter schema (`createOverlaySchema(updatedTableSchema)`).
  - Translate each snapshot row to the new shape:
    - `add column`: append the new column's default (or NULL) to each row.
    - `drop column`: drop the corresponding cell index.
    - `rename column`: column index unchanged; only the schema metadata rotates.
  - Re-insert into the new overlay (preserving tombstone column position).
- Replace the old overlay state with the new one. Keep `hasChanges` if it was set.

The savepoint stack on the registered connection has to roll forward to the new overlay too; if that proves complex, treat ALTER as a hard barrier: flush the overlay to the underlying first, then alter.

## Validation

- New unit tests in `packages/quereus-store/test/isolated-store.spec.ts`:
  - Within a transaction: INSERT a row, ALTER TABLE ADD COLUMN, SELECT — the inserted row survives and has NULL (or default) in the new column.
  - Within a transaction: INSERT a row, ALTER TABLE DROP COLUMN, SELECT — surviving columns retain their values.
  - Within a transaction: INSERT a row, ALTER TABLE RENAME COLUMN, SELECT under the new column name — row is intact.
- `yarn test:store -- --grep "41.2-alter-column"` passing.
- `yarn test` — no regressions.

## TODO

- In `IsolationModule.alterTable`, snapshot existing overlay rows and migrate them onto the post-alter overlay schema (do not just drop them).
- Handle ADD / DROP / RENAME column shapes correctly.
- Confirm the registered connection's savepoint stack still operates correctly against the new overlay.
- Add the three unit tests above.
- Remove `41.2-alter-column.sqllogic` from `MEMORY_ONLY_FILES`.
- Run `yarn test`, `yarn test:store` and confirm green.
