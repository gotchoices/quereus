description: An index declared on a materialized view inside `declare schema` was created on the first apply but never seen by the schema comparison, so every later diff asked to create it again and a second apply failed. The comparison now sees these indexes, and they are rebuilt when the materialized view itself is dropped and recreated to move it to another storage module.
architecture: docs/schema-declarative.md
files: packages/quereus/src/schema/catalog.ts (`collectSchemaCatalog` table loop), packages/quereus/src/schema/schema-differ.ts (`computeSchemaDiff`: `tablesRecreatedByModuleMove` in the table loop's module-move branch, and its use in the index loop), packages/quereus/test/apply-schema-index-order.spec.ts, packages/quereus/test/declarative-equivalence.spec.ts, docs/schema-declarative.md (line 16)
----
# Declared index on a maintained table never converges — review handoff

## What changed

**Arm 1 — catalog lists maintained-table indexes.** `collectSchemaCatalog` used to push a maintained table (one built by `create materialized view` or `create table … maintained as`) and `continue` before its index loop, so none of its indexes reached `catalog.indexes`. The maintained table now runs the same `displayIndexesForTable` loop as a plain table; only a plain view (`isView` without a derivation) is skipped. The old comment claimed the skip hid "internal covering indexes"; there are none on a maintained table beyond the implicit UNIQUE structure every table gets, which `displayIndexesForTable` already filters. Comment rewritten.

Effect: `diff schema` / `apply schema` now see declared indexes on maintained tables (re-diff is empty, re-apply succeeds), a removed declaration plans `DROP INDEX`, and `exportSchemaDeclaration` (and the bundle exporter built on it) now includes them. `schema()` already listed them, so the read surfaces now agree.

**Arm 2 — indexes survive a backing-module move.** A module move (`materialized view mv as …` → `… using mem2() as …`, applied with `allow_destructive = true`) is planned as `DROP TABLE mv` + recreate, and the table drop takes its indexes with it. Before arm 1 the differ never saw the live index, so it always re-emitted `create index` by accident; after arm 1 an unchanged index would emit nothing and be lost. `computeSchemaDiff` now records the declared names of tables sent through the module-move recreate (`tablesRecreatedByModuleMove`) and the index loop folds that into the existing body-change recreate condition: drop (actual name) + create (declared stmt, carrying declared tags), counted in `indexRecreates` so `rename_policy = 'require-hint'` does not trip, and no separate `SET TAGS`.

Probed plan for a plain move: `DROP TABLE IF EXISTS mv`, `DROP INDEX IF EXISTS mv_x`, `create materialized view mv using mem2 …`, `create index mv_x on mv (x) with tags (…)`. Note the ticket text said the index drop runs *before* the table drop — it doesn't: `generateMigrationPlan` emits table drops before index drops, so the `DROP INDEX IF EXISTS` is a no-op behind the `DROP TABLE`. Index names are unique per schema (`SchemaManager.createIndex` refuses a collision), so the bare-name drop cannot hit another table's index. Rename + move (`mv` → `mv2` via `quereus.previous_name`, plus module move) probed too: `ALTER TABLE mv RENAME TO mv2`, `DROP TABLE IF EXISTS mv2`, `DROP INDEX IF EXISTS mv_x`, create `mv2`, `create index mv_x on mv2 (x)`; converges.

## Undo plan check (no change needed)

In the module-move plan the `DROP TABLE` comes first and is `irreversible` (`UndoRenderer.droppedTable`), so the apply's undo journal is poisoned before it runs and the following `DROP INDEX` step's undo (`recreateIndex` → `create index mv_x on mv …`) is never journaled. The only way the index drop's undo could run unpoisoned is if the table were absent from the pre-apply catalog, in which case its index is absent too and `recreateIndex` returns nothing to undo. A plain `DROP INDEX` of a maintained table's index (declaration removed the index) undoes to `create index … on m`, which works on a maintained table (the reshape test creates one).

## Tests

- `apply-schema-index-order.spec.ts` › "an index declared on a maintained table converges, and removing it plans DROP INDEX" — the ticket's repro: apply, empty re-diff, second apply succeeds; removing the index plans exactly one `DROP INDEX IF EXISTS m_v` and applies. Fails without arm 1.
- `apply-schema-index-order.spec.ts` › existing "indexes a column added to a maintained table in the reshape round" — now reads the catalog (`indexNames`) instead of the live table; comment pointing at this bug removed. Fails without arm 1.
- `declarative-equivalence.spec.ts` › "a backing-module move recreates the moved table's indexes on the new incarnation" — diff under `require-hint` plans drop+create of `mv_x` without throwing; after the destructive apply the new `mv` carries `mv_x` and the re-diff has no index ops. Fails without arm 2.

## Validation run

- `yarn workspace @quereus/quereus test`: 11176 passing, 23 pending, 0 failing.
- `yarn workspace @quereus/quereus lint`: clean.
- `yarn workspace @quereus/bundle test`: 14 passing (its exporter now includes maintained-table indexes).
- Not run: `yarn test:store` (store-backed logic tests). Arm 1 changes what the catalog lists for maintained tables on the store backend too; `displayIndexesForTable` handles store-mode synthetics the same way for both table kinds, but a reviewer may want a store run.

## Things for the reviewer to look at

- Any stored schema hash or catalog fingerprint computed from `collectSchemaCatalog` over a schema with maintained-table indexes changes value with arm 1 (backwards compatibility is waived project-wide; noting it in case a sync peer compares hashes across versions).
- The `diff schema` output for a module move now shows a no-op `DROP INDEX IF EXISTS` after the `DROP TABLE`. The alternative (create-only, subtracting from the require-hint create count) avoids the no-op line but needs a second counter; the drop+create form reuses the body-change branch unchanged.
