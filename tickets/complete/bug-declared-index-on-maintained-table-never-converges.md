description: An index declared on a materialized view inside `declare schema` was created on the first apply but never seen by the schema comparison, so every later diff asked to create it again and a second apply failed. The comparison now sees these indexes, and they are rebuilt when the materialized view itself is dropped and recreated to move it to another storage module.
architecture: docs/schema-declarative.md
files: packages/quereus/src/schema/catalog.ts (`collectSchemaCatalog` table loop), packages/quereus/src/schema/schema-differ.ts (`computeSchemaDiff`: `tablesRecreatedByModuleMove`), packages/quereus/test/apply-schema-index-order.spec.ts, packages/quereus/test/declarative-equivalence.spec.ts, docs/schema-declarative.md, docs/materialized-views.md
----
# Declared index on a maintained table never converges

## What landed

- **Catalog lists maintained-table indexes.** `collectSchemaCatalog` used to skip the index loop for maintained tables (from `create materialized view` or `create table … maintained as`). It now runs the same `displayIndexesForTable` loop as for a plain table; only a plain view is skipped. As a result `diff schema` / `apply schema` converge on a declared index over a maintained table, removing the declaration plans `DROP INDEX`, and `exportSchemaDeclaration` (and the bundle exporter) now include these indexes.
- **Indexes survive a backing-module move.** A module move is planned as `DROP TABLE` + recreate, and the table drop removes the table's indexes. `computeSchemaDiff` records the tables recreated this way (`tablesRecreatedByModuleMove`), and the index loop recreates every matched index on them: a `DROP INDEX IF EXISTS`, which is a no-op after the table drop, then `CREATE INDEX` with the declared tags. The pair is counted in `indexRecreates`, so `rename_policy = 'require-hint'` does not reject it.
- Tests: the ticket's repro (converge, then removing the index plans one `DROP INDEX`) in `apply-schema-index-order.spec.ts`; the module move recreating `mv_x` under `require-hint` in `declarative-equivalence.spec.ts`. The existing reshape test now reads the catalog instead of the live table.

## Review findings

Read the `ticket(implement): bug-declared-index-on-maintained-table-never-converges` diff first, then the handoff.

- **Correctness (checked; no defect found).** Probed with a temporary spec (deleted afterwards):
  - body change (`set maintained as`): the index stays and the re-diff is empty;
  - detach (`drop maintained`) and re-attach: the index stays and the re-diff is empty;
  - hinted rename `m` → `m2` via `"quereus.previous_name"`: plans only `ALTER TABLE m RENAME TO m2`, index follows, re-diff empty;
  - module move with an index tag change plus a new index: one drop+create for the changed index, a create for the new one, tags correct, re-diff empty;
  - export round-trip: `create materialized view` + imperative `create index` exports as `index mv_v on mv (…)`, and applying that export to a fresh database converges.
- **Undo / restore check (checked; no defect found).** The pre-apply catalog fingerprint used by the apply's undo-on-failure path now includes maintained-table indexes. Probed a plan whose `set maintained as` succeeds and whose later `create unique index` fails on duplicate data: the unwind restores and the fingerprint matches, index present. A failure after a module move reports "partially migrated" because `DROP TABLE` cannot be undone. That was already the documented behaviour.
- **Engine-built indexes on maintained tables (checked).** Confirmed the rewritten catalog comment: no code path adds an `IndexSchema` to a maintained table beyond what `displayIndexesForTable` already filters (implicit UNIQUE structures). A covering materialized view links to a source table's UNIQUE constraint and adds no index to itself.
- **Type safety / DRY / resource cleanup / performance:** nothing found. The change removes a branch and adds one `Set` lookup per matched index.
- **Docs (fixed).** `docs/materialized-views.md` still said the declarative differ does not track a backing-module change ("silent no-op"), which is wrong. Rewrote that sentence, added an **Indexes** bullet to § Declarative-schema integration, and noted in the backing-module bullet that the table's declared indexes are recreated. `docs/schema-declarative.md` was already updated by the implementer.
- **Tests (kept as is).** Both new tests reproduce a defect at the diff/apply layer and fail without their arm. Nothing to cut or add.
- **Store backend (ran).** The implementer had not run `yarn test:store`. Ran `yarn workspace @quereus/quereus test:store`: 11169 passing, 30 pending, 0 failing. Lint clean, and the two touched spec files pass in memory mode (148 passing).
- **Tripwires / tickets:** none. The implementer flagged that schema hashes over schemas with maintained-table indexes change value. Backwards compatibility is waived project-wide, so no action. The no-op `DROP INDEX IF EXISTS` line in a module-move plan is a deliberate choice that reuses the existing recreate branch, and `docs/schema-declarative.md` documents it.
