description: Review fix for store-backed DML double-emit on onDataChange / onTransactionCommit
files:
  - packages/quereus/src/runtime/emit/dml-executor.ts          # gate fix + new helper
  - packages/quereus-store/test/database-events.spec.ts         # new regression test
----

# Review: store-backed DML double-emit fix

## What was done

Added a 14-line helper `moduleHasNativeDataEvents(ctx, tableSchema)` to
`dml-executor.ts` (above `emitAutoDataEvent`) and replaced the three identical
auto-event gate predicates in `runInsert`, `runUpdate`, and `runDelete`
(previously `!hasNativeEventSupport(vtab)`) with `!moduleHasNativeDataEvents(ctx, tableSchema)`.

The helper resolves the owning module via `ctx.db._getVtabModule(moduleName)` —
the same resolution `hookModuleEmitter` used when the module was registered —
and passes the **module** to `hasNativeEventSupport`, exactly as the schema-event
gate in `schema/manager.ts:emitAutoSchemaEventIfNeeded` does.

No other files were touched.

## Regression test

New file `packages/quereus-store/test/database-events.spec.ts` — 8 tests:
- insert / update / delete → exactly 1 `onDataChange` event (with StoreModule + StoreEventEmitter)
- insert / update / delete → exactly 1 data event across all `onTransactionCommit` batches
- control: memory table in the same DB still gets its auto-emitted event (single)
- control: DDL `create table … using store` → 1 `onSchemaChange` (schema gate unchanged)

All 8 new tests pass. Full suite: 6328 + 126 passing, 0 failures. Engine lint: clean.

## Known gaps / reviewer focus

- The fix is scoped to the three `runInsert`/`runUpdate`/`runDelete` gate sites.
  The `processEvictions` helper and per-operation event emission code paths are
  downstream of `needsAutoEvents`, so they are automatically covered by the gate fix.
- No behavior change for memory or isolation-wrapped tables.
- The `hasNativeEventSupport` import is still used (inside the new helper); no dead-import.
- Tests assert on count, not shape — the shape is already covered by the engine's
  own `database-events.spec.ts`.
