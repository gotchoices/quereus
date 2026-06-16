description: Store-backed DML double-emits on the engine event channels (onDataChange / onTransactionCommit). The DML auto-event gate checks native event support against the vtab *instance* (which a StoreTable does not expose) instead of the owning *module* (which carries the hooked emitter), so the engine auto-emits IN ADDITION to the module's native emitter. Fix: make the DML gate resolve the owning module and check it — mirroring the already-correct schema (DDL) gate.
prereq:
files:
  - packages/quereus/src/runtime/emit/dml-executor.ts          # 3 gate sites: lines 497, 726, 874 — the fix
  - packages/quereus/src/util/event-support.ts                 # hasNativeEventSupport(obj) — unchanged; called with the module now
  - packages/quereus/src/core/database.ts                      # _getVtabModule(name) → { module, auxData } (internal accessor)
  - packages/quereus/src/schema/manager.ts                     # reference: DDL gate (lines 1519, 2520) already module-level (CORRECT, do not change)
  - packages/quereus-store/src/common/store-module.ts          # StoreModule.getEventEmitter (module-level only); constructor(provider, eventEmitter?)
  - packages/quereus-store/test/store-ryow.spec.ts             # in-memory provider + Database wiring pattern to copy for the regression test
difficulty: easy
----

# Fix: store-backed DML double-emits on the engine event channels

## Reproduced (confirmed during fix stage)

With a `StoreModule` constructed **with** a `StoreEventEmitter` (the production
config — quoomb-web / sync wire one), a single autocommit
`insert into <store-table>` delivers **2** identical events on both
`db.onDataChange` and the `db.onTransactionCommit` batch. A bare
`new StoreModule(provider)` (no emitter) delivers 1 (only the engine auto-emit),
which is why most existing store tests never tripped on it.

Control: `create table … using store` (DDL) delivers exactly **1**
`onSchemaChange` event — the schema-event gate is already module-level and
correct. The bug is DML-only.

Reproduction harness used (in `packages/quereus-store/test/`, against the built
`@quereus/quereus`): register `new StoreModule(provider, new StoreEventEmitter())`,
subscribe `onDataChange` / `onTransactionCommit`, run one insert, count events →
observed 2, expected 1.

## Root cause

The DML executor's auto-event gate, at three identical sites
(`dml-executor.ts:497` runInsert, `:726` runUpdate, `:874` runDelete):

```ts
const needsAutoEvents = ctx.db._needsDataEvents() && !hasNativeEventSupport(vtab);
```

`hasNativeEventSupport(obj)` returns true only when `obj.getEventEmitter()` is a
function returning a defined value. It is passed the **vtab instance** (`vtab` —
a `StoreTable`). `StoreModule` exposes `getEventEmitter` only at the **module**
level (`store-module.ts:240`); its `StoreTable` instances do **not**. So the
check is `false` → `needsAutoEvents` is `true` → the engine auto-emits. Meanwhile
the StoreModule's native emitter, hooked at the **module** level in
`registerModule` (`database.ts` → `hookModuleEmitter`), **also** emits. Two
events per row.

Why memory never trips: `MemoryTable.getEventEmitter()` delegates to its manager
(`memory/table.ts`), so the instance check accidentally works for memory — and
the default memory module has no emitter, so the gate correctly auto-emits. The
asymmetry is specific to the store, whose table instances carry no emitter.

The schema/DDL gate (`schema/manager.ts:1519`, `:2520` via
`emitAutoSchemaEventIfNeeded`) already does the right thing: it resolves the
module — `getModule(vtabModuleName)?.module` — and checks **that**. The DML gate
must match it.

## Fix (gate fix — option 1 from the source ticket)

Resolve the owning module from `tableSchema.vtabModuleName` and check native
support on the **module**, exactly as the schema gate does. This is correct and
self-consistent in every wrapping case because it keys on the same
`vtabModuleName → getModule` resolution that `registerModule`/`hookModuleEmitter`
keyed the hook on:

- registered module = `StoreModule` (has `getEventEmitter`) → hooked → native
  emits → gate sees native → **suppress** auto-emit → 1 event. ✓
- registered module = `IsolationModule` wrapping a store (no `getEventEmitter`,
  it does not forward one) → not hooked → no native emission → gate sees no
  native → **auto-emit** → 1 event. ✓
- default `memory` (no emitter) → not hooked → auto-emit → 1 event (unchanged). ✓
- `memory` with an injected emitter → hooked → suppress auto-emit (unchanged). ✓

No behavior change for memory; the store path drops from 2 → 1.

### Shape

Add a small local helper in `dml-executor.ts` (sibling to `emitAutoDataEvent`)
and use it at all three gate sites. Use the engine-internal accessor
`ctx.db._getVtabModule(name)` (returns `{ module, auxData } | undefined`; it
delegates to `schemaManager.getModule`):

```ts
/**
 * True when the table's owning *module* natively emits data events (its emitter
 * is hooked at the database level by registerModule). The auto-event gate must
 * consult the MODULE, not the vtab instance: a module like StoreModule exposes
 * getEventEmitter only at the module level — its table instances do not — so an
 * instance check spuriously reports "no native support" and the engine
 * double-emits alongside the module's native emitter. Mirrors the schema-event
 * gate in schema/manager.ts (emitAutoSchemaEventIfNeeded).
 */
function moduleHasNativeDataEvents(ctx: RuntimeContext, tableSchema: TableSchema): boolean {
	const moduleName = tableSchema.vtabModuleName;
	const moduleReg = moduleName ? ctx.db._getVtabModule(moduleName) : undefined;
	return hasNativeEventSupport(moduleReg?.module);
}
```

Then at lines 497 / 726 / 874:

```ts
const needsAutoEvents = ctx.db._needsDataEvents() && !moduleHasNativeDataEvents(ctx, tableSchema);
```

Keep the `hasNativeEventSupport` import (still used inside the helper). `vtab`
stays in scope for `vtab.update!` etc. — only the gate predicate changes.

## Regression test

The quereus (engine) package has **no** dependency on `@quereus/store`, so the
test cannot literally live in the engine `database-events` suite as the source
ticket suggested — place it in **`packages/quereus-store/test/`** instead (this
package depends on both `@quereus/quereus` and the store module). Suggested file:
`packages/quereus-store/test/database-events.spec.ts`.

Copy the in-memory `KVStoreProvider` factory from `store-ryow.spec.ts`. Construct
the module **with** an emitter (this is what exposes the bug):
`db.registerModule('store', new StoreModule(provider, new StoreEventEmitter()))`.

Assert on **counts**, not presence:

- single `insert` → exactly 1 `onDataChange` event AND exactly 1 data event
  across all `onTransactionCommit` batches.
- single `update` → 1 each.
- single `delete` → 1 each.
- control: a non-store **memory** table in the same DB still delivers exactly 1
  (guard against a regression on the legitimate auto-emit path).
- (optional) DDL `create table … using store` → 1 `onSchemaChange` (already
  passes today; locks in the asymmetry).

Note: with the bug present, the insert currently yields `onTransactionCommit data
event count: 2, batches: 2` (the store coordinator's per-table autocommit flush
plus the engine auto-emit). After the fix it must be 1.

## Validation

- `yarn workspace @quereus/store build` is **not** how the test resolves the
  engine — the test imports the built `@quereus/quereus`. Rebuild the engine
  first so the gate fix is in `dist`:
  `yarn workspace @quereus/quereus run build` (stream with `… 2>&1 | tee /tmp/build.log`),
  then run the new spec:
  `node --import ./packages/quereus-store/register.mjs node_modules/mocha/bin/mocha.js "packages/quereus-store/test/database-events.spec.ts" --reporter spec`.
- Run the full store + engine suites to confirm no regression:
  `yarn test` (memory-backed engine + all workspaces). The store-specific path is
  also covered by `yarn test:store` if a store-path regression is suspected.
- `yarn workspace @quereus/quereus run lint` (eslint + test typecheck) for the
  engine change.

## TODO

- [ ] Add `moduleHasNativeDataEvents(ctx, tableSchema)` helper to `dml-executor.ts`.
- [ ] Replace the gate predicate at `dml-executor.ts:497`, `:726`, `:874` to use it.
- [ ] Rebuild `@quereus/quereus`.
- [ ] Add `packages/quereus-store/test/database-events.spec.ts` with count-based
      assertions for insert/update/delete (store w/ emitter) + a memory control.
- [ ] Run the new spec, `yarn test`, and engine `lint`; confirm all green.
- [ ] Confirm DDL still single-emits (already correct — schema gate untouched).
