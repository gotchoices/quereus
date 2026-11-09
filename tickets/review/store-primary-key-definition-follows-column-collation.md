description: When the store module changed a text primary-key column's collation (at CREATE, and on ALTER COLUMN SET COLLATE) it left the table's primary-key definition at the old collation, so the isolation layer missed staged rows and data-change events split case-only key updates. Both producers now keep the two in step, and the engine refuses to register any table schema where they disagree.
architecture: docs/schema.md
files: packages/quereus/src/schema/table.ts (`rederivePrimaryKeyCollations`, `assertPrimaryKeyCollationsMatchColumns`), packages/quereus/src/schema/schema.ts (`Schema.addTable`), packages/quereus/src/index.ts, packages/quereus-store/src/common/store-module-schema-rewrite.ts (`reconcilePkCollations`), packages/quereus-store/src/common/store-module-alter-column.ts (`updatedSchema`, ~line 144), packages/quereus/src/planner/rules/access/rule-select-access-path.ts (`resolveIndexKeyCollations`), packages/quereus/src/vtab/index-descriptor.ts (`reversedIndexDescriptor`), packages/quereus-store/test/data-event-key-contract.spec.ts, packages/quereus-store/test/isolated-store.spec.ts, docs/invariants.md (SCH-006), docs/schema.md (§ TableSchema), docs/store-catalog-persistence.md, docs/store.md
----
## What changed

`TableSchema.primaryKeyDefinition[i].collation` is meant to be a copy of the member column's `collation`. Two store producers rewrote the column and not the definition; the engine consumers that read the definition (the engine data-change event comparators in `dml-executor.ts`, the isolation overlay's `constraintComparator` via `primaryKeyDescriptor`) then disagreed with the store's own key bytes for the rest of the session.

- **Helper** — `rederivePrimaryKeyCollations(schema)` in `schema/table.ts` (exported from `@quereus/quereus`): re-derives each definition member's collation from its column; returns the input object when nothing differs, else a copy with a fresh frozen definition.
- **Producers** — `reconcilePkCollations` (store CREATE) and the store's ALTER COLUMN `updatedSchema` both pass their rewritten schema through the helper.
- **Boundary check** — `assertPrimaryKeyCollationsMatchColumns(table)` runs in `Schema.addTable` on every registration; a mismatch (compared as `|| 'BINARY'`, uppercased) throws `INTERNAL` naming the schema, table, column and both collations. An out-of-range definition index also throws `INTERNAL`. Across `yarn test` and `yarn test:store` it found no other producers.
- **Workarounds removed** — `resolveIndexKeyCollations` no longer reads the column for the engine's primary-key descriptor (`readsColumnCollation` gone); `reversedIndexDescriptor` no longer overrides primary-key collations. `primaryKeyCollationLookup` still reads the column, which is now equivalent; its comment did not mention the staleness, so it was left alone.
- **Docs** — new register entry SCH-006 in `docs/invariants.md`; a back-linked paragraph under `docs/schema.md` § TableSchema; one sentence on the CREATE bullet in `docs/store-catalog-persistence.md`; fixed a stale `docs/store.md` link that pointed at schema.md for "Per-column PK key collation" (it lives in store-catalog-persistence.md).

## Tests added

- `data-event-key-contract.spec.ts`, engine-auto-path describe (store registered with no emitter):
  - `agrees on an undecorated text key, which the store keys under its NOCASE default` — reproduction of the CREATE arm: a case-only update stays one `update`.
  - `agrees on a key column altered to NOCASE` — reproduction of the ALTER COLUMN SET COLLATE arm.
  - The existing NOCASE test and the two new ones share a small `expectCaseOnlyRewriteIsOneUpdate` helper.
- `isolated-store.spec.ts`, `collated PK range under an open transaction`: `an equality read finds a staged row differing in case on an undecorated text key` — a staged `'ALICE'` is found by `name = 'alice'` inside the transaction.
- No separate test for the `addTable` check: every registration in the suite exercises it. Checked by temporarily bypassing both producer calls: the three new tests and two existing store tests failed with the new `INTERNAL` "disagrees with the column's collation NOCASE" error; then restored.

## Validation run

- `yarn build` — clean.
- `yarn test` — all green (quereus 11126 passing / 26 pending, store 1994, isolation 453, the rest unchanged).
- `yarn test:store` — 11119 passing, 33 pending.
- `yarn lint`, `yarn docs:check`, `yarn workspace @quereus/store typecheck` — clean.
- `mv-rehydrate-adopt.spec.ts` is inside the store suite and passed with both arms and the check in place.

## Known gaps / things for the reviewer to weigh

- The memory module's `buildAlterColumnPlan` (`vtab/memory/layer/alter-column.ts`, `updatedPkDef`) still propagates the collation inline rather than calling the new helper. It is correct and the check covers it; switching it over would be a small DRY change that I left out of scope.
- The check only sees schemas that reach `Schema.addTable`. A module's privately cached schema that is never registered (e.g. a store table's own copy) is not checked; both store producers feed their result to registration, so this matters only for a future producer that caches without registering.
- `rederivePrimaryKeyCollations` does not freeze the outer schema object (it spreads the input, as `reconcilePkCollations` did before). The memory path freezes its own result; the store paths never froze theirs.
- The comparison is case-insensitive (`normalizeCollationName`). Column collations are already canonicalized upstream, so this only matters for a hand-built schema with a lowercase name.
