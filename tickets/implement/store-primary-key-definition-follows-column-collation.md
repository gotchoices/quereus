description: When the store module changes the collation of a text primary-key column (at CREATE, and on ALTER COLUMN SET COLLATE), it updates the column but leaves the table's primary-key definition with the old collation, so the isolation layer misses rows staged in a transaction and data-change events report case-only key updates as a delete plus an insert. Keep the two in step, and make the engine refuse any table schema where they disagree.
architecture: docs/schema.md
files: packages/quereus-store/src/common/store-module-schema-rewrite.ts (`reconcilePkCollations`), packages/quereus-store/src/common/store-module-alter-column.ts (~line 141, `updatedSchema`), packages/quereus/src/schema/schema.ts (`Schema.addTable`), packages/quereus/src/schema/table.ts (`rekeySchemaPrimaryKey`, `findPKDefinition`), packages/quereus/src/vtab/memory/layer/alter-column.ts (~line 373, `updatedPkDef` — the memory module's correct version), packages/quereus/src/planner/rules/access/rule-select-access-path.ts (`resolveIndexKeyCollations`, ~line 1567), packages/quereus/src/vtab/index-descriptor.ts (`reversedIndexDescriptor`, ~line 200), packages/quereus/src/runtime/emit/dml-executor.ts (~line 467, `pkEventComparators`), packages/quereus-isolation/src/isolated-table.ts (`constraintComparator`), packages/quereus-store/test/data-event-key-contract.spec.ts, packages/quereus-store/test/isolated-store.spec.ts, docs/store.md
repro: verified
----
## The defect

`TableSchema.primaryKeyDefinition[i].collation` is, by construction, a copy of the member column's `collation`: `findPKDefinition` (and its column/constraint helpers, and the synthesized all-columns key) copy `columns[i].collation || 'BINARY'`, and no DDL form gives a key member a collation different from its column. Every producer that changes a key column's collation must therefore rewrite the definition too. The memory module does (`alter-column.ts` `updatedPkDef`), and so does `rekeySchemaPrimaryKey` for ALTER PRIMARY KEY. Two store producers do not:

- **CREATE** — `reconcilePkCollations` rewrites an undecorated text key column's `collation` to the store's table key collation K (NOCASE by default) and returns `{ ...schema, columns, columnIndexMap }`, leaving the definition at BINARY.
- **ALTER COLUMN SET COLLATE** — `store-module-alter-column.ts` builds `updatedSchema` with new `columns` and `indexes` but the old `primaryKeyDefinition`.

On reopen the definition is rebuilt from the persisted DDL (`findPKDefinition` copies the column), so it is consistent again; the staleness lasts for the session that ran the DDL.

The store's own storage keys from the columns (`resolvePkKeyCollations`), so it is internally consistent. The engine consumers that read the definition are wrong:

- `dml-executor.ts` `pkEventComparators` (engine data-change event path — used when a store table is registered without its own event emitter).
- `primaryKeyDescriptor` (`vtab/index-descriptor.ts`) → `IsolatedTable.constraintComparator`, which filters the isolation overlay's staged rows against a primary-key seek window.

## Reproduction (run during fix, throwaway specs since deleted)

All with a `StoreModule` over `InMemoryKVStore`, same provider shape as `data-event-key-contract.spec.ts`.

- `create table t (k text not null, v text, primary key (k)) using store` → column `NOCASE`, `primaryKeyDefinition` `[{"index":0,"desc":false,"collation":"BINARY"}]`. `table_info` reports the column as NOCASE. With no emitter registered, `insert ('apple','x')` then `update t set k = 'APPLE' where k = 'apple'` delivered `delete ['apple']` + `insert ['APPLE']`; expected one `update` keyed `['APPLE']` (the existing `collate nocase` test in that file shows the correct shape).
- `create table t (k text collate binary primary key, v text) using store; alter table t alter column k set collate nocase` → same stale BINARY definition, same split event.
- With `createIsolatedStoreModule`: `create table t (k text primary key, v text) using store; insert ('Bob','c'); begin; insert ('ALICE','x')`; then `select * from t where k = 'alice'` returned nothing, and `where k >= 'a' and k < 'b'` returned nothing (both should return the staged ALICE row); the committed row was found by `k = 'bob'`; after `commit` the equality found ALICE.

Applying only the CREATE half of the fix below made all three CREATE cases behave correctly, and the whole `@quereus/store` suite (1991 passing) and `@quereus/isolation` suite (453 passing) stayed green. That change was reverted so this ticket starts from HEAD. `yarn test:store` was not run.

## The fix

**Producers.** `reconcilePkCollations` rewrites `primaryKeyDefinition` alongside `columns` when it changes anything (each member's `collation` from the rewritten column, as `rekeySchemaPrimaryKey` does; keep it frozen). `store-module-alter-column.ts` propagates a collation change into the matching `primaryKeyDefinition` entry, mirroring memory's `updatedPkDef`. Both store paths should probably share one small helper that re-derives the definition's collations from the columns, so a third producer has something to call; put it beside `rekeySchemaPrimaryKey` in `schema/table.ts` and export it if the store needs it.

**Boundary invariant.** `Schema.addTable` is the one seam every registration passes through (CREATE, every module's ALTER result, ANALYZE, the store's reopen stamp — see its doc comment). Add a check there that each `primaryKeyDefinition[i].collation` (normalized, `?? 'BINARY'`) equals its column's `collation` (normalized, `?? 'BINARY'`), raising `StatusCode.INTERNAL` naming the table and column. This catches the whole class — any module, any future DDL path — in tests, instead of in whichever consumer happens to read the definition. If the check fires on paths not listed here, fix those producers too (they are the same bug); do not loosen the check.

**Remove the workarounds** that exist only because of this staleness, once the invariant holds:
- `resolveIndexKeyCollations` (`rule-select-access-path.ts`): drop `readsColumnCollation` and read `key.collation`; update its doc comment.
- `reversedIndexDescriptor` (`index-descriptor.ts`): drop the primary-key `collation` override and its comment.
- `primaryKeyCollationLookup` in the same rule file reads the column; that is now equivalent and can stay, but check its comment does not cite the staleness.
- Grep for other comments describing the definition as lagging the column (`lag`, `pre-rewrite`, `reconcilePkCollations` mentions in `pk-key-resolution.ts`, `store-module-access-plan.ts` ~line 572, `materialized-view-helpers.ts` ~line 388, `schema/manager.ts` ~line 3095) and correct any that state it.

**Materialized views.** `describeBackingShapeMismatch` (`materialized-view-helpers.ts` ~line 1999) compares the live table's `primaryKeyDefinition[].collation` to the normalized shape's column collation. Before the fix a store backing created in the same session read BINARY there while the shape read NOCASE; after it both read NOCASE, matching what reopen already produced. The store suite passed with the CREATE fix, but confirm the MV rehydrate/adopt specs (`packages/quereus-store/test/mv-rehydrate-adopt.spec.ts`) still pass with the ALTER half and the assertion in place.

## Tests

- In `data-event-key-contract.spec.ts`, engine-auto-path `describe` (store registered with no emitter): an undecorated `k text not null` primary key — case-only update stays one `update`. This is the reproduction for the CREATE arm.
- Same file: the ALTER COLUMN SET COLLATE arm — `collate binary` key altered to NOCASE, then a case-only update stays one `update`.
- In `isolated-store.spec.ts`: undecorated text key, a staged row differing in case from the probe, an equality read inside the transaction finds it.
- No separate test for the `addTable` assertion: the whole suite exercises it on every registration.

## TODO

- Add a helper in `schema/table.ts` that re-derives `primaryKeyDefinition[].collation` from the columns; use it in `reconcilePkCollations` and in `store-module-alter-column.ts`'s `updatedSchema` when the collation changed.
- Add the definition/column collation check to `Schema.addTable` (INTERNAL error); fix any further producers it exposes.
- Remove the `readsColumnCollation` workaround in `resolveIndexKeyCollations` and the primary-key override in `reversedIndexDescriptor`; correct comments that describe the staleness.
- Add the three tests above.
- Update `docs/store.md` (and `docs/schema.md` if it describes `primaryKeyDefinition`) to state that a key member's definition collation always equals its column's, on every backend.
- Run `yarn build`, `yarn test`, `yarn lint`; run `yarn workspace @quereus/store test` and `yarn workspace @quereus/isolation test`; run `yarn test:store` if it finishes within the time limit, otherwise note it as deferred.
