description: StoreTable now coerces incoming row values to declared column logical types on INSERT/UPDATE, mirroring the memory path (INTEGER/REAL affinity + JSON normalization). Addresses JSON idempotency at the isolation overlay→underlying flush via a `preCoerced` bypass flag on `UpdateArgs`.
files:
  packages/quereus-store/src/common/store-table.ts
  packages/quereus-isolation/src/isolated-table.ts
  packages/quereus/src/vtab/table.ts
  packages/quereus/test/logic.spec.ts
  packages/quereus-store/test/column-coercion.spec.ts
----

## What was built

Brings the store-backed virtual table to parity with the memory path on incoming-value coercion at INSERT/UPDATE time.

- **`StoreTable.coerceRow`** in `packages/quereus-store/src/common/store-table.ts`: protected helper that maps each cell of a `Row` through `validateAndParse(value, column.logicalType, column.name)` — the same helper `MemoryTableManager.performInsert/performUpdate` use. Pre-checks `row.length > columns.length` and throws an `ERROR`-status `QuereusError` mirroring the memory wording.
- `StoreTable.update()` `insert` and `update` cases coerce *before* PK extraction, key building, serialization, secondary-index updates, and event emission, so the coerced row is the single source of truth downstream. `delete` is untouched (only needs `oldKeyValues` for the key lookup).
- **`UpdateArgs.preCoerced`** added in `packages/quereus/src/vtab/table.ts`. When `true`, the vtab may skip its own coercion pass. JSDoc explains the rationale and idempotency hazard.
- **`IsolatedTable.flushOverlayToUnderlying`** in `packages/quereus-isolation/src/isolated-table.ts` passes `preCoerced: true` for both insert and update flush operations. The memory overlay has already coerced via `validateAndParse` on its own write path, and re-coercing JSON would attempt `JSON.parse("hello")` on a JSON-scalar string that the overlay already unwrapped, throwing.
- **`MEMORY_ONLY_FILES`** in `packages/quereus/test/logic.spec.ts`: removed `10-distinct_datatypes.sqllogic` and `06-builtin_functions.sqllogic` — they now pass under store mode with coercion.

## Key files
- `packages/quereus-store/src/common/store-table.ts:425-434` — `coerceRow` helper
- `packages/quereus-store/src/common/store-table.ts:591` — `insert` coercion gate
- `packages/quereus-store/src/common/store-table.ts:673` — `update` coercion gate
- `packages/quereus/src/vtab/table.ts:28-35` — `UpdateArgs.preCoerced` definition
- `packages/quereus-isolation/src/isolated-table.ts:873,879` — flush sites passing `preCoerced: true`

## Testing

Spec tests (`packages/quereus-store/test/column-coercion.spec.ts`) exercise `StoreModule` directly (no isolation layer) so the coercion path is observable end-to-end:
- INTEGER affinity: `'100'` → `100` on INSERT and UPDATE; non-numeric string rejected.
- REAL affinity: `'2.71'` → `2.71`.
- TEXT affinity: `42` → `'42'`.
- INTEGER PK: `INSERT '1'` then `WHERE pk = 1` finds it (PK key bytes match across types).
- JSON: `'{"a":1}'` parsed into native object; `typeof` reports `'json'`; invalid JSON rejected.
- Persistence round-trip: INTEGER and JSON columns survive a database close/reopen with `rehydrateCatalog` as native types (not raw text).

Sqllogic coverage: `03.6-type-system.sqllogic`, `97-json-function-edge-cases.sqllogic`, `10-distinct_datatypes.sqllogic`, `06-builtin_functions.sqllogic`, and `10.2-column-features.sqllogic` all green under store mode.

## Verification

- `yarn workspace @quereus/quereus test` — **2443 passing**, 0 failing.
- `yarn workspace @quereus/store test` — **216 passing**, 0 failing.
- `yarn test:store` — 566 passing, 1 failing (`50-declarative-schema.sqllogic` "Deferred constraint execution found multiple candidate connections" — pre-existing on `main`, unrelated; outside this ticket's scope).
- `yarn workspace @quereus/quereus lint` — 0 errors (275 pre-existing `no-explicit-any` warnings, no new ones).

## Review notes

- `preCoerced` on `UpdateArgs` is the right shape vs. a parallel `updateFromOverlay` method: it routes through the existing dispatch surface, requires no new method on `VirtualTable`, and is opt-in (defaults to coercion). The flag is documented at the type definition and at both bypass sites.
- The design choice to keep coercion on the memory overlay (and have the underlying skip) preserves overlay query semantics (overlay `query` returns native objects/numbers immediately) without touching memory-mode code paths.
- `UpdateResult.row` / `replacedRow` carrying the coerced row is consistent with memory's pre-existing behavior; dml-executor and upsert flows treat these as opaque logical rows. The auto-event path in `dml-executor.ts` derives PK from `newRow` for tracking — same as before, no regression introduced.
