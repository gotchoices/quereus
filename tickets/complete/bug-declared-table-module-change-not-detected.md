---
description: Changing the storage module named on an existing table in a schema declaration now moves the table (with an explicit acknowledgement, since a plain table loses its rows), and tables declared without a module are no longer reported as moving when the session's default module is not memory.
architecture: docs/sql-ddl.md#semantics-and-features
files:
  - packages/quereus/src/schema/schema-differ.ts        # declaredTableModule, tableModuleMove; computeSchemaDiff pre-pass (moduleMoves); SchemaDiff.moduleMigrations
  - packages/quereus/src/schema/catalog.ts              # CatalogTable.module
  - packages/quereus/src/schema/catalog-rendering.ts    # renderTable renders module
  - packages/quereus/src/schema/schema-hasher.ts        # renderDeclaredSchemaCanonical includes the schema's using(...) defaults
  - packages/quereus/src/schema/manager.ts              # findChildBlockingDrop (skipReference callback)
  - packages/quereus/src/runtime/emit/schema-declarative.ts  # moduleMigrationRefusal, refuseModuleMoveLeavingDanglingRows, referenceGoneBeforeDrops
  - packages/quereus/test/declarative-equivalence.spec.ts
  - docs/sql-ddl.md
  - docs/schema-declarative.md
  - docs/materialized-views.md
---

# Declared module changes on tables

## What landed

- **One rule for which module a declared table is on** (`declaredTableModule`): the item's own `using`; else, for the table form, the schema's `using (default_vtab_module, default_vtab_args)` via the same `applyTableDefaults` the create path uses; else `memory` for `materialized view` sugar; else nothing is pinned. The session `default_vtab_module` is never consulted (reasons in `docs/sql-ddl.md`, "What a declaration pins").
- **Comparison** (`tableModuleMove`) against `CatalogTable.module` (now carried for every table, replacing `maintained.backingModuleName/Args`), same-kind pairs only. A moved table skips `computeTableAlterDiff` entirely; `SchemaDiff.maintainedModuleMigrations` became `moduleMigrations` with a `maintained` flag.
- **Fast path**: the catalog rendering has a per-table `module` line, and the declared rendering includes the schema's module defaults (so the version hash of a schema with `using (…)` changed, and editing those defaults now changes it).
- **Apply gate**: `allow_destructive` now covers plain tables with a message that says rows are lost; a move whose `DROP TABLE` the foreign-key check would refuse is refused before any DDL runs.

## Review findings

Read the `ticket(implement): bug-declared-table-module-change-not-detected` diff first, then the handoff.

**Fixed in this pass (minor, one defect with two arms):** the new up-front foreign-key refusal (`refuseModuleMoveLeavingDanglingRows`) refused moves whose plan would have succeeded. Reproduced both arms with a throwaway spec (deleted) before changing code:
- the declaration removes the child's named foreign key while moving the parent — `generateMigrationPlan` runs constraint drops before table drops (unless `removalsStillReferenced`), so the `DROP TABLE` would not be blocked, yet the refusal fired;
- the referencing child is itself hinted-renamed and moved — `tablesToDrop` carries the child's declared (new) name while the live table still has its old name when the refusal runs, so the "dropped first" skip missed it.

Fix: `SchemaManager.findChildBlockingDrop`'s callback now receives the foreign key too (`skipReference(childTable, fk)`), and the new `referenceGoneBeforeDrops` in `schema-declarative.ts` maps live child names through the plan's table renames and skips a reference whose child is dropped or whose constraint is in that child's `constraintsToDrop` when constraint drops run first. Both repro scenarios now apply. Added one test (`a module move is refused up front only while a referencing row would survive to the DROP TABLE`) — it also covers the refusal itself, which the implementer had only verified by hand. `docs/sql-ddl.md` and `docs/schema-declarative.md` now state when the refusal applies.

**Checked, no change:**
- Live args can't churn: `vtabArgs` on a registered table comes straight from the create statement (`resolveModuleInfo` in `manager.ts`); the store module's own `vtabArgs` rebuild only feeds a fallback schema that `importCatalog` overwrites. So declared args compare against what was declared.
- `generateDeclaredDDL` does not apply schema defaults, so adding `moduleDefaultsLine` to the declared rendering is needed, not redundant. Raw `default_vtab_args` text differences (whitespace) only cost a fast-path miss, never a wrong diff.
- No stale references to `backingModuleName/Args` on the catalog or to `maintainedModuleMigrations` remain (the remaining `backingModuleName` hits are the materialized-view create path, unrelated).
- Logical tables get `module: { name: '' }`; inert because the logical diff never compares modules (as the handoff said).
- Error handling: the refusal raises `StatusCode.CONSTRAINT` before any DDL; `applyTableDefaults` throwing on malformed `default_vtab_args` at compare time is the right place to surface it.
- Implementer's two tests pin the two reproductions (plain-table move incl. schema-default-only edit through the fast path; unpinned tables under a non-memory session default). They test behaviour, not wiring — kept.

**Tripwires (already parked by the implementer, left as is):** attach/detach combined with a module change converges in two applies — `NOTE:` on `tableModuleMove` and stated in `docs/sql-ddl.md`.

**Not filed:** nothing rose to a ticket. Version-hash change for schemas declaring `using (…)` is intended and documented in `docs/schema-declarative.md`.

**Validation:** `yarn workspace @quereus/quereus run lint` clean; the declarative-equivalence module tests pass (11); `yarn test` — all workspaces green (exit 0, no failing suites). `yarn test:store` was not re-run in review: the only code changed here is the apply-time refusal predicate, which is module-agnostic; the implementer's store run was green.
