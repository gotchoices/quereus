description: An index declared on a materialized view (a "maintained" table) inside `declare schema` gets created on the first apply, but the schema comparison never sees it, so every later diff asks to create it again and a second apply fails with "index already exists". Fix the comparison so these indexes are seen, and make sure they are rebuilt when the materialized view itself is dropped and recreated.
architecture: docs/schema-declarative.md
files: packages/quereus/src/schema/catalog.ts (`collectSchemaCatalog`, maintained-table branch ~283), packages/quereus/src/schema/schema-differ.ts (`computeSchemaDiff`: table loop's `maintainedModuleMigration` branch ~735, index loop ~890), packages/quereus/test/apply-schema-index-order.spec.ts (maintained-table test ~97, comment at ~115), packages/quereus/test/declarative-equivalence.spec.ts (backing-module move tests ~1578–1850), docs/schema-declarative.md, docs/schema-undo-plan.md
repro: verified
----
# Declared index on a maintained table never converges

## Observed (reproduced at HEAD 3ca858d5c)

```sql
declare schema main {
	table src { id integer primary key, v integer }
	table m { id integer primary key, v integer } maintained as select id, v from src
	index m_v on m (v)
}
apply schema main   -- ok; m_v exists on the live table
diff schema main    -- still: create index m_v on m (v)
apply schema main   -- fails: Failed to execute DDL: create index m_v on m (v)
```

A plain `create index` on a maintained table is likewise invisible to `diff schema`, so a declaration that omits it never proposes `DROP INDEX`, and `exportSchemaDeclaration` leaves it out.

## Cause

`collectSchemaCatalog` (`src/schema/catalog.ts`) pushes a maintained table and `continue`s before the per-table index loop, so none of its indexes reach `catalog.indexes`. The comment there claims this hides the maintained table's "internal covering indexes", but there are none to hide:

- Probed live `TableSchema.indexes` for a projection maintained table, a `group by` MV, a `select distinct` MV and a maintained table with a `unique` column. The only engine-built index on any of them is the UNIQUE constraint's implicit `_uc_<cols>` structure — the same one plain tables get — and `displayIndexesForTable` already filters it.
- A "covering MV" (`docs/schema.md` § TableDerivation, `UniqueConstraintSchema.coveringStructureName`) is the maintained table itself acting as the covering structure for a *source* table's UNIQUE constraint; it adds no index to the maintained table.
- `schema()` (`src/func/builtins/schema.ts` ~146) already lists maintained-table indexes through `displayIndexesForTable`; the catalog is the one read surface that disagrees.

## Fix — two arms

### Arm 1: list maintained-table indexes in the catalog

In `collectSchemaCatalog`, run the `displayIndexesForTable` loop for maintained tables too (the `isView` skip stays for plain views only — a maintained table may legacy-carry `isView`, so keep the maintained check ahead of it). Fix the comment that claims internal covering indexes exist.

Verified by probe: with only this change, the repro converges (re-diff empty, second apply succeeds) and removing the declared index yields `DROP INDEX IF EXISTS m_v`. All 72 spec files mentioning maintained tables / materialized views pass, and the full `yarn test` in `packages/quereus` passes (11176 passing).

### Arm 2: recreate indexes on a maintained table the plan drops and recreates

Arm 1 alone introduces a regression. A backing-module move (`materialized view mv as …` → `materialized view mv using mem2() as …`, applied with `allow_destructive = true`) is planned as `DROP TABLE mv` + recreate (`computeSchemaDiff`'s table loop, `alterDiff.maintainedModuleMigration` branch). The table drop takes its indexes with it. Before arm 1 the index loop never saw the actual index, so it always re-emitted `create index` — correct by accident. After arm 1 an unchanged, name-matched index emits nothing, and the index is lost. Verified by probe: plan was `DROP TABLE IF EXISTS mv; create materialized view mv using mem2 …` only; live `mv` had no indexes afterwards, and the next diff proposed `create index mv_x`.

Fix: record the declared (lowercased) names of the tables the table loop sends through the module-move recreate, and in the index loop treat a matched declared index on such a table like a body-change recreate — push `indexesToDrop` (the actual name; renders `DROP INDEX IF EXISTS`, which runs in step 2 before the table drop and is harmless) plus `indexesToCreate`, increment `indexRecreates` so the `require-hint` guard (`enforceRequireHint`, trips whenever creates and drops are both non-zero) does not count it as an unhinted rename, and skip the in-place `SET TAGS` branch (the recreate carries declared tags). Key by the index's *declared* table name — that is also the name the recreate renders under in the rename-plus-module-move case (`dropName` comment in the table loop). Index creates already run after maintained creates (docs/schema-declarative.md § Migration Order, step 5), so the create sees the new incarnation.

Check while doing this: the apply undo plan (`docs/schema-undo-plan.md`, `recreateIndex` in `schema-differ.ts` ~4106) for a failed apply after the module-move `DROP TABLE` — the table's restore must bring the index back, or the index drop's undo must not run against a missing table. Before arm 1 there was never a catalog index on a maintained table, so this path is new. If it needs more than a small change, say so in the review handoff rather than widening this ticket.

No other path drops and recreates a maintained table under the same name: attach / detach / re-attach (`set maintained as` / `drop maintained`) are in-place alters, and a body change plus module move is the same single recreate.

## Tests

- Repro (arm 1): in `test/apply-schema-index-order.spec.ts`, extend or sit beside the existing maintained-table test (~97): declare an index on a maintained table, apply, assert `diff schema` is empty and a second apply succeeds; then drop the index from the declaration and assert `DROP INDEX` is planned. Update that existing test to read the catalog (`indexNames`) instead of the live table and remove its comment pointing at this bug (~115).
- Module move (arm 2): in `test/declarative-equivalence.spec.ts` beside the backing-module-move tests, declare `index mv_x on mv (x)`, move the module with `allow_destructive = true`, assert the index exists on the new incarnation and the re-diff is empty.

## Docs

- `docs/schema-declarative.md` line ~16 (`SchemaDiff.maintainedModuleMigrations`): add that indexes on the moved table are dropped and recreated with it.
- The catalog comment in `collectSchemaCatalog` (arm 1).

## TODO

- Arm 1: collect indexes for maintained tables in `collectSchemaCatalog`; correct its comment.
- Arm 2: in `computeSchemaDiff`, recreate matched declared indexes on module-move-recreated tables (drop + create, counted in `indexRecreates`, no separate SET TAGS).
- Check the undo plan for a failed apply after a module move with an index on the moved table.
- Add the arm 1 repro test and the arm 2 module-move test; update the existing maintained-table test in `apply-schema-index-order.spec.ts`.
- Update `docs/schema-declarative.md`.
- Run `yarn workspace @quereus/quereus test` and `yarn workspace @quereus/quereus lint`.
