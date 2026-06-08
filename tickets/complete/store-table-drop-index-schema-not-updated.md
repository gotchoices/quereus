---
description: Added `StoreModule.dropIndex` that refreshes the connected `StoreTable`'s cached `tableSchema` (strips the index + derived `UNIQUE` constraint), releases the cached index-store handle, tears down the physical store via `deleteIndexStore ?? closeIndexStore`, and emits a `drop`/`index` `schemaChange` event. Review pass also added `IsolationModule.dropIndex` so the new fix is reached under the canonical isolation-wrapped configuration (`createIsolatedStoreModule`); without it `SchemaManager.dropIndex` fell through to "no module hook" and `StoreModule.dropIndex` was never invoked under `yarn test:store`.
files:
  packages/quereus-store/src/common/store-module.ts            # StoreModule.dropIndex
  packages/quereus-store/src/common/store-table.ts             # releaseIndexStore
  packages/quereus-store/test/column-default-conflict.spec.ts  # store-direct regression tests
  packages/quereus-isolation/src/isolation-module.ts           # IsolationModule.dropIndex (added in review)
  packages/quereus-isolation/test/isolation-layer.spec.ts      # isolation-wrapped regression (added in review)
  packages/quereus/src/schema/manager.ts                       # reference: SchemaManager.dropIndex (engine-side)
  packages/quereus/src/vtab/memory/layer/manager.ts            # reference: MemoryTableManager.dropIndex
  packages/quereus/test/logic/drop-unique-index.sqllogic       # logic coverage (now passes under store)
---

## Summary

Before this ticket, `StoreModule` had no `dropIndex` implementation, so
`SchemaManager.dropIndex` fell through with no module hook and the
connected `StoreTable` kept its constructor-captured schema. After
`DROP INDEX`, subsequent INSERT/UPDATE/DELETE still maintained entries
in the dropped index store (`StoreTable.updateSecondaryIndexes`) and —
for UNIQUE indexes — the synthesized `UniqueConstraintSchema` tagged
`derivedFromIndex` kept firing from `StoreTable.checkUniqueConstraints`.

## Implementation

The implement stage added:

- `StoreModule.dropIndex(db, schemaName, tableName, indexName)` — strips
  the index and any `derivedFromIndex`-tagged `UniqueConstraintSchema`
  from the cached `TableSchema`, collapses `uniqueConstraints` to
  `undefined` when empty, calls `table.updateSchema(updatedSchema)`
  **before** physical teardown, closes/releases the cached handle via
  `table.releaseIndexStore`, then calls `provider.deleteIndexStore ??
  closeIndexStore`, and emits a `drop`/`index` `schemaChange` event.
  Mirrors the lowercase-name and collapse-to-undefined behavior of
  `SchemaManager.dropIndex` and `MemoryTableManager.dropIndex`.
- `StoreTable.releaseIndexStore(indexName)` — drops the entry from
  `StoreTable.indexStores` and best-effort-closes the handle.
- In-memory test fixture refinement (`createInMemoryProvider` in
  `column-default-conflict.spec.ts`): `closeIndexStore` /
  `deleteIndexStore` now evict the cached store entry so a subsequent
  `getIndexStore` returns a fresh empty store, mirroring how the LevelDB
  provider's cache evicts (`packages/quereus-plugin-leveldb/src/provider.ts:95-123`).

Three unit cases under `column-default-conflict.spec.ts`:
1. UNIQUE constraint synthesized by `CREATE UNIQUE INDEX` is cleared
   after `DROP INDEX` (duplicate insert succeeds post-drop).
2. Non-UNIQUE index store stops being maintained on subsequent inserts.
3. `schemaChange` event with `type=drop, objectType=index` is emitted.

## Review findings

### Reviewed

- **Behavior vs. `SchemaManager.dropIndex` / `MemoryTableManager.dropIndex`** —
  the filter on `derivedFromIndex?.toLowerCase()`, the lowercase index-name
  comparison, and the collapse-to-`undefined` for empty
  `uniqueConstraints` all match the engine and memory module
  (`packages/quereus/src/schema/manager.ts:1319-1331`,
  `packages/quereus/src/vtab/memory/layer/manager.ts:1348-1357`).
- **`updateSchema` ordering** — confirmed correct: the cached schema is
  refreshed *before* `releaseIndexStore` / `deleteIndexStore`. On a
  physical-teardown failure the in-memory schema has already lost the
  index, so subsequent DML cannot keep poking the half-deleted store.
  The asymmetry vs. `createIndex` (which builds entries before updating
  the schema) is intentional and matches the "fail-safe-to-no-index"
  direction.
- **Catalog symmetry** — neither `StoreModule.createIndex` nor
  `StoreModule.dropIndex` persists index DDL (the catalog stores only
  `CREATE TABLE` via `saveTableDDL`; `generateTableDDL` omits indexes,
  and `generateIndexDDL` is only used in tests). So nothing for `drop`
  to remove from the catalog — symmetric with `create` doing nothing
  there either. Index persistence across reconnect is a pre-existing,
  separately-tracked concern outside this ticket.
- **Provider teardown semantics** — verified `deleteIndexStore` closes
  the handle and removes the on-disk directory on LevelDB
  (`packages/quereus-plugin-leveldb/src/provider.ts:117-123`) and the
  IndexedDB equivalent (`packages/quereus-plugin-indexeddb/src/provider.ts:127-131`).
  The `closeIndexStore` fallback for providers that don't supply
  `deleteIndexStore` is the same one the test fixture now implements.
- **`releaseIndexStore` close handling** — the close is best-effort and
  swallowed; no in-flight write batch in the data coordinator holds a
  raw reference to the index handle (the coordinator's
  `delete`/`put(indexStore=…)` queues take the handle reference at
  enqueue time, which fires before `dropIndex` enters its teardown).
- **Test coverage of the store-direct path** — the three unit cases
  cover synthesized-UC removal, non-UNIQUE maintenance halt, and event
  emission. The `drop-unique-index.sqllogic` engine test additionally
  covers (a) basic UNIQUE drop, (b) coincident-name preservation (a
  CREATE-TABLE-time `UNIQUE(b)` survives dropping a `UNIQUE INDEX` on
  `a`), and (c) partial UNIQUE round-trip with predicate.
- **Lint / typecheck / unit tests** —
  `yarn workspace @quereus/store run typecheck` clean.
  `yarn workspace @quereus/quereus run lint` clean.
  `yarn workspace @quereus/store test` → **269 passing** (was 266; the
  +3 new cases all green).
  `yarn workspace @quereus/quereus test` → **2942 passing, 2 pending**;
  `drop-unique-index.sqllogic` passes against memory.

### Fixed in this pass (minor)

- **`IsolationModule.dropIndex` was missing — invalidating the
  implementer's `test:store` claim.** Verified by directly running
  `yarn workspace @quereus/quereus test:store --grep 'drop-unique-index'`
  before the fix: the test failed with
  `ConstraintError: UNIQUE constraint failed: dui_basic (a)` after
  `drop index ix_dui_basic_a;` (the exact failure mode the ticket
  describes). Root cause: under the canonical
  `createIsolatedStoreModule({ provider })` configuration (used by
  `yarn test:store` and recommended by every plugin's README),
  `SchemaManager.dropIndex` calls `moduleReg?.module?.dropIndex` on the
  registered module, which is `IsolationModule`. `IsolationModule` had
  `createIndex` but no `dropIndex`, so the engine fell through with no
  module hook and `StoreModule.dropIndex` was *never invoked* — the
  fix in `StoreModule` was bypassed in the configuration the ticket
  was supposed to fix.

  Added `IsolationModule.dropIndex` mirroring its existing
  `createIndex` shape: prefer the underlying VirtualTable's
  instance-level `dropIndex` (which exists on MemoryTable and forwards
  through its manager to keep `MemoryTable.tableSchema` fresh), fall
  back to `this.underlying.dropIndex(db, ...)` (StoreModule), and
  forward the drop to any per-connection overlay matching this
  `(schema, table)` so its cached schema and any synthesized UNIQUE
  constraint stop firing.

  After the fix, `test:store --grep 'drop-unique-index'` passes; full
  `test:store` is 636 passing / 1 failing — the **same** pre-existing
  failure in `29.1-column-level-conflict-clause.sqllogic:144` the
  implementer flagged (UPDATE PK-change-REPLACE FK ON DELETE CASCADE
  under LevelDB), unrelated to this work and already filed as outside
  scope.

  Added a regression test in
  `packages/quereus-isolation/test/isolation-layer.spec.ts`
  (`describe: 'DROP INDEX forwards through the isolation layer'`) that
  drives `CREATE UNIQUE INDEX` → INSERT → confirm duplicate rejected →
  `DROP INDEX` → confirm duplicate now accepted, under
  `IsolationModule({ underlying: new MemoryTableModule() })`. Before
  the fix this case threw `UNIQUE constraint failed`; after, it passes.

### Filed as follow-up (major)

- **`DROP INDEX` inside an active transaction with a live overlay is
  broken at the isolation layer.** While verifying the
  `IsolationModule.dropIndex` fix I drafted a second test that
  `BEGIN; INSERT; DROP INDEX; INSERT (duplicate);` — the duplicate
  still failed because the overlay-side `MemoryTable` could not safely
  refresh its schema mid-transaction (`ensureSchemaChangeSafety` tries
  to consolidate to the base layer but encounters the active
  connection's transaction state and the post-consolidate state still
  has the synthesized UC firing). This is a deeper isolation-layer
  bug — not introduced by this ticket and not exercised by any
  existing test — so I trimmed the second test and filed
  `fix/isolation-drop-index-inside-transaction.md`. The defensive
  per-overlay `dropIndex` loop I added in `IsolationModule.dropIndex`
  is kept (it's a no-op in autocommit, which is all that's exercised
  today, and is the right plumbing for the follow-up fix to build on).

### Observations — left as-is

- **Concurrency latching** — `StoreModule.dropIndex` is unlatched
  against concurrent INSERT/UPDATE, matching the unlatched
  `StoreModule.createIndex`. `MemoryTableManager.dropIndex` uses
  `Latches.acquire`; the store side does not. Already flagged in the
  implement-stage "Known gaps"; out of scope here and consistent with
  the rest of the store module's locking model.
- **Index-DDL persistence across reconnect** — pre-existing gap
  unrelated to this ticket. Neither `createIndex` nor `dropIndex`
  persists/removes index DDL in the catalog; index recovery on
  reconnect is a separate concern.

### Categories with nothing to report

- **Resource cleanup** — `releaseIndexStore` evicts from
  `StoreTable.indexStores` *before* awaiting close (so a concurrent
  `ensureIndexStore` cannot resurrect the closed handle); the close
  is best-effort and swallowed, intentional and documented.
- **Type safety** — no `any` introduced; the new `dropIndex` signatures
  match the optional `dropIndex` on `VirtualTableModule`.
- **Performance** — schema-rewriting is two `Array.filter` passes over
  the (usually short) `indexes` / `uniqueConstraints` arrays. No new
  hot-path cost.
- **Docs** — `docs/schema.md` describes the schema lifecycle at a
  level that doesn't enumerate per-module DDL hooks; the user-facing
  contract (`DROP INDEX` clears UNIQUE) is unchanged.

## Tests run (review pass)

- `yarn workspace @quereus/store run typecheck` — clean.
- `yarn workspace @quereus/isolation run typecheck` — clean.
- `yarn workspace @quereus/quereus run lint` — clean.
- `yarn workspace @quereus/store test` — 269 passing.
- `yarn workspace @quereus/isolation test` — 65 passing (was 64; +1 new
  `'DROP INDEX forwards through the isolation layer'` case).
- `yarn workspace @quereus/quereus test` — 2942 passing, 2 pending.
- `yarn workspace @quereus/quereus test:store --grep 'drop-unique-index'`
  — passes (was failing before the `IsolationModule.dropIndex` fix).
- `yarn workspace @quereus/quereus test:store` — 636 passing,
  4 pending, 1 failing (pre-existing
  `29.1-column-level-conflict-clause.sqllogic:144`, unchanged).
