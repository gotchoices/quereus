description: Store-backed DML double-emitted on the engine event channels (onDataChange / onTransactionCommit). The DML auto-event gate checked native-event support against the vtab *instance* (a StoreTable, which carries no getEventEmitter) instead of the owning *module* (StoreModule, which carries the hooked emitter), so the engine auto-emitted IN ADDITION to the module's native emitter — 2 identical events per row mutation. Fixed by resolving the owning module and gating on it, mirroring the already-correct schema (DDL) gate.
files:
  - packages/quereus/src/runtime/emit/dml-executor.ts          # moduleHasNativeDataEvents helper + 3 gate sites (runInsert/runUpdate/runDelete)
  - packages/quereus/src/util/event-support.ts                 # hasNativeEventSupport(obj) — unchanged; now called with the module
  - packages/quereus/src/core/database.ts                      # _getVtabModule; hookModuleEvents (gate/hook key on same getEventEmitter condition)
  - packages/quereus/src/schema/manager.ts                     # reference: emitAutoSchemaEventIfNeeded — the module-level gate the fix mirrors
  - packages/quereus-store/test/database-events.spec.ts        # regression test (9 tests)
----

# Complete: store-backed DML double-emit fix

## What was done

`dml-executor.ts` gained a 14-line helper `moduleHasNativeDataEvents(ctx, tableSchema)`
that resolves the owning module via `ctx.db._getVtabModule(tableSchema.vtabModuleName)`
and passes the **module** to `hasNativeEventSupport`. The three identical auto-event
gates in `runInsert` / `runUpdate` / `runDelete` changed from
`!hasNativeEventSupport(vtab)` (instance) to `!moduleHasNativeDataEvents(ctx, tableSchema)`
(module), exactly matching the schema-event gate in
`schema/manager.ts:emitAutoSchemaEventIfNeeded`.

A `StoreModule` constructed with a `StoreEventEmitter` (the production config) now
delivers exactly **1** data event per store-backed insert/update/delete on both
`db.onDataChange` and the `db.onTransactionCommit` batch (was 2). No behavior change
for memory tables or isolation-wrapped tables.

Regression test `packages/quereus-store/test/database-events.spec.ts` (9 tests):
single insert/update/delete → 1 event on each channel; a multi-row insert → exactly
N events (no per-row doubling); memory-table control (still 1 auto-emitted); DDL
control (still 1 onSchemaChange).

## Review findings

### Correctness (checked — sound)

- **Gate ⟺ hook consistency.** The native-emit hook (`Database.hookModuleEvents`,
  called at `registerModule`) and the new gate both key on the *same* condition —
  the module exposes a defined `getEventEmitter()`. So "gate suppresses auto-emit"
  ⟺ "the module's native emitter was hooked at registration." No risk of 0 events
  (suppress without a native emitter) and no double-emit. This holds for StoreModule
  because its emitter is fixed in the constructor (stable across registration → DML).
- **Mirrors the schema gate exactly.** `moduleHasNativeDataEvents` is the data-side
  twin of `emitAutoSchemaEventIfNeeded` (`schema/manager.ts`) — same
  `vtabModuleName → getModule → hasNativeEventSupport(module)` resolution. The DDL
  gate was already correct; DML now matches.
- **Null-safety.** `hasNativeEventSupport(undefined)` returns `false` (a missing
  module ⇒ auto-emit), so an unresolved `vtabModuleName` degrades safely.
- **`needsAutoEvents` threading.** The single per-statement `needsAutoEvents` flag
  flows into every downstream emission site (`processInsertRow`, `processUpdateRow`,
  `processDeleteRow`, `processEvictions`, and the UPSERT/REPLACE arms). All
  auto-emit sites are gated by it — no orphaned emission path was missed.
- **No dead code.** `vtab` (from `getVTable`) is still required for the actual
  `vtab.update()` calls; the `hasNativeEventSupport` import is still used inside the
  new helper. The duplicate `_getVtabModule` lookup (once in `getVTable`, once in
  the helper) is a cheap map lookup — not worth threading the module through.

### Tests (checked — extended)

- The implementer's 8 tests were single-row (distinguish 1 from 2). **Added** a
  multi-row insert test asserting exactly N events — pins the *per-row* nature of
  the old doubling and guards against a future "emit once per statement" regression.
  The new test fails (6 ≠ 3) without the fix.
- Coverage now: all three DML ops × both channels, multi-row, memory control, DDL
  control. UPSERT/REPLACE eviction paths are gated by the same flag and so are
  covered transitively; no dedicated UPSERT event-count test was added (the
  emission sites are all behind `needsAutoEvents`).

### Docs (checked — accurate, no change)

- `docs/module-authoring.md` (§ "How It Works", § "For Modules with/without Native
  Events") already describes native support as a *module*-level `getEventEmitter()`
  marker and the engine auto-emit fallback. It described the intended behavior, never
  the buggy instance check — so it already reflects the post-fix reality. No edit needed.

### Validation

- Engine lint (eslint + `tsc` over test files): clean.
- Engine test suite: **6328 passing**, 9 pending, 0 failures.
- Store test suite: **607 passing**, 0 failures (negative-path tests log expected
  rehydration/rollback errors; all assert-pass).
- New regression spec: **9 passing**.

### Out of scope / no ticket filed

- Isolation-wrapped store (`IsolationModule` wrapping `StoreModule` without
  forwarding `getEventEmitter`): not hooked ⇒ engine auto-emits ⇒ still exactly 1
  event. Correct under this fix; analyzed during fix stage, no defect. No follow-up
  needed.

No major findings — no new fix/plan/backlog tickets required.
