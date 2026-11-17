---
description: Changing the storage module named on an existing table in a schema declaration now moves the table (with an explicit acknowledgement, since a plain table loses its rows), and tables declared without a module are no longer reported as moving when the session's default module is not memory.
architecture: docs/sql-ddl.md#semantics-and-features
files:
  - packages/quereus/src/schema/schema-differ.ts        # declaredTableModule, tableModuleMove, ModuleIdentity/ModuleMove (~2895-2960); computeSchemaDiff pre-pass (moduleMoves) + table loop; SchemaDiff.moduleMigrations
  - packages/quereus/src/schema/catalog.ts              # CatalogTable.module (replaces maintained.backingModuleName/Args), filled in tableSchemaToCatalog
  - packages/quereus/src/schema/catalog-rendering.ts    # renderTable renders module; renderMaintained no longer does
  - packages/quereus/src/schema/schema-hasher.ts        # renderDeclaredSchemaCanonical now includes the schema's using(...) defaults
  - packages/quereus/src/schema/manager.ts              # findChildBlockingDrop split out of assertNoReferencingChildrenForDrop
  - packages/quereus/src/runtime/emit/schema-declarative.ts  # moduleMigrationRefusal, refuseModuleMoveLeavingDanglingRows, the allow_destructive gate
  - packages/quereus/test/declarative-equivalence.spec.ts    # two new tests at the end of the backing-module describe block
  - docs/sql-ddl.md                                     # allow_destructive bullet + "What a declaration pins" bullet (Semantics and Features → Safety)
  - docs/schema-declarative.md                          # moduleMigrations bullet, gating paragraph, snapshot table, version-hash paragraph
  - docs/materialized-views.md                          # § Declarative-schema integration, backing-module bullet
---

# Declared module changes on tables — review handoff

## What changed

**One answer to "which module should this declared table be on"** — `declaredTableModule` in `schema-differ.ts`:

- the item's own `using <module> [(args)]`;
- else, for the table form (plain or `table … maintained as`), the schema's `using (default_vtab_module, default_vtab_args)` — computed by calling `applyTableDefaults`, the same function the create path uses;
- else, for `materialized view …` sugar, `memory`;
- else nothing is pinned and the module is not compared. The session `default_vtab_module` is deliberately not consulted (reasons in `docs/sql-ddl.md`, "What a declaration pins").

**Comparison** — `tableModuleMove` compares that against the live `CatalogTable.module` (normalized name + canonical args), only when both sides are the same kind (plain/plain or maintained/maintained). It runs once per matched table in the `computeSchemaDiff` pre-pass and the result is stored in `moduleMoves`. A moved table no longer gets `computeTableAlterDiff` called at all (its alter diff used to be computed and thrown away), so `TableAlterDiff.maintainedModuleMigration` and the `refuseUndroppable` option of `diffUnnamedConstraints` are gone.

**Representation** — `CatalogTable.module?: { name; args? }` for every table (absent ⇒ memory, no args), replacing `maintained.backingModuleName/Args`. `SchemaDiff.maintainedModuleMigrations` → `moduleMigrations` with a `maintained: boolean` per entry.

**Apply fast path** — two holes closed, both required for correctness, not just the build:
- the catalog rendering now has a `module` line per table (the collected `ddl` elides a `using` that matches the session default, so a move done by direct DDL could leave it unchanged);
- the declared rendering (`renderDeclaredSchemaCanonical`) now includes the schema's `using (default_vtab_module …)` defaults. Without this, editing only the schema default left both renderings identical and the fast path skipped the diff. Side effect: the version hash (`explain schema`) of a schema that declares `using (…)` changes, and changing those defaults now changes the version. Documented in `docs/schema-declarative.md`.

**Apply gate** — the `allow_destructive` refusal now covers plain tables, and its message separates "dropped and recreated empty — their rows are lost" from "re-materialized as a new incarnation". New: `refuseModuleMoveLeavingDanglingRows` refuses up front (before any DDL) when another table still has rows whose foreign key references a table being moved — previously the apply failed at the `DROP TABLE` step with a misleading "could not be restored … partial effect stands" message. It reuses the drop guard's probe via the new `SchemaManager.findChildBlockingDrop`; children the same plan drops are skipped (they are dropped first). This also applies to maintained tables, which had the same mid-apply failure before.

## Verified by hand (throwaway spec, deleted)

- Plain table with a declared index, moved: the index is dropped and recreated after the table (`tablesRecreatedByModuleMove` works unchanged).
- Parent with a foreign-key child: child has rows → refused up front, parent untouched; child empty → move succeeds and the foreign key still enforces against the recreated parent.
- Hinted rename + module move on a plain table (`t` → `t2 using mem2` with `quereus.previous_name`), with a dependent view: works, re-diff empty.
- Direct-DDL move (`drop table t; create table t … using mem2` under a mem2 session default) is detected on the next `apply schema` even after a recorded snapshot.

## Tests added

In `packages/quereus/test/declarative-equivalence.spec.ts`, end of the backing-module `describe`:

- `a module change on a PLAIN table is an ack-gated drop+recreate that loses its rows` — the reproduction of arm 1: diff records the move (`maintained: false`, drop + `create table … using mem2`); apply without the ack throws naming `t` and "rows are lost", leaving it on memory with its row; with the ack it lands on mem2, empty, and re-diffs empty; an args-only change is a move; and a schema-default-only edit (`default_vtab_module` 'mem2' → 'memory') is refused after a snapshot was recorded — this last step is what fails if the declared rendering omits the defaults.
- `tables declared without \`using\` are unpinned, so a session default module does not read as a move` — the reproduction of arm 2: under `default_vtab_module = 'mem2'`, a plain table and a `table … maintained as` with no `using` land on mem2, the MV sugar on memory, and the re-diff is empty.

Existing maintained-table tests were only renamed (`moduleMigrations`, `module?.name`, `maintained: true` in expected entries).

## Validation run

- `yarn workspace @quereus/quereus run lint` — clean.
- `yarn test` — all workspaces green.
- `yarn workspace @quereus/quereus run test:store` — 11171 passing, 30 pending, 0 failing.

## Known gaps / for the reviewer to weigh

- **Attach/detach + module change converges in two applies.** Kept the ticket's "same kind only" rule: the first apply attaches/detaches in place, the second sees a same-kind pair and (with the ack) moves it. Parked as a `NOTE:` on `tableModuleMove` and stated in `docs/sql-ddl.md`. Comparing across kinds would converge in one apply but turns a non-destructive attach into a destructive recreate when the modules differ.
- **Version-hash change** for schemas that declare `using (…)` (see above) — intended, but it is a visible change for anyone pinning hashes.
- `applyTableDefaults` now runs at compare time too, so a malformed `default_vtab_args` JSON throws on a diff with only matched tables (before, only when something was created). Seems right; flagging it.
- The up-front foreign-key refusal only looks at children with rows *now*; a plan step earlier in the same apply that inserts referencing rows cannot exist (migration steps are DDL only), so this should be complete, but the reviewer may want to confirm.
- Logical-schema tables (`vtabModuleName: ''`) get `module: { name: '' }` in the catalog. The logical diff path never compares modules, so this is inert; only noted because it renders.
