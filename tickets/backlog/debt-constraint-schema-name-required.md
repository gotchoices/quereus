description: After every unnamed CHECK and UNIQUE rule starts getting an automatic name, the code still allows a rule with no name and keeps dozens of fallbacks for that case. Make the name mandatory in the schema types so a nameless rule cannot exist, and delete the fallbacks and the "cannot drop an unnamed rule" error they guard.
prereq: create-table-names-every-unnamed-constraint
architecture: docs/schema-rename-detection.md#unnamed-constraint-lifecycle-body-matched
files:
  - packages/quereus/src/schema/table.ts               # RowConstraintSchema (~1111), ForeignKeyConstraintSchema (~1247), UniqueConstraintSchema (~1389) — `name?: string`
  - packages/quereus/src/schema/schema-differ.ts       # diffUnnamedConstraints — the "created without a name" throw, prunedByColumnDrop, nameless-preference in matching, constraintNamesAtAddTime's nameless-UNIQUE arm
  - packages/quereus/src/schema/catalog.ts             # CatalogUnnamedConstraint.name optional; implicitIndexName / implicitIndexNameForColumns fallback
  - packages/quereus/src/runtime/row-constraints.ts    # generateDefaultConstraintName
  - packages/quereus/src/vtab/memory/layer/manager.ts  # `uc.name ?? implicitIndexNameFor(uc)` sites; RENAME COLUMN re-naming of a nameless UNIQUE's structure
  - packages/quereus-store/src/common/implicit-unique-index.ts, packages/quereus-store/src/common/store-table-constraints.ts
  - packages/quereus-isolation/src/alter-migration.ts  # installOverlayUniqueConstraint name fallback
tradeoffs: The schema types are part of the public module-authoring surface, so third-party modules that build constraint objects by hand would have to supply names, and the change touches many files for no user-visible behaviour change.
----

# Make constraint names mandatory in the schema types

Once `create-table-names-every-unnamed-constraint` lands, every engine path (CREATE TABLE, store reopen, `ALTER … ADD CONSTRAINT`, `ADD COLUMN` inline, the declarative differ) stores a CHECK / UNIQUE / FOREIGN KEY under either the user's name or a reserved `_`-prefixed auto-name. The schema types still declare `name?: string`, so the nameless state remains representable, and the code keeps paying for it:

- the declarative differ's "it was created without a name, so no statement can drop it" refusal and the helpers around it (`prunedByColumnDrop`, preferring the nameless actual when matching, the nameless-UNIQUE arm of `constraintNamesAtAddTime`);
- `name ?? <derived>` fallbacks across the engine, store and isolation packages — 49 lines matched by `grep -rnE "\.name \?\? |\.name \|\| '|uc\.name \?\?" --include=*.ts quereus/src quereus-store/src quereus-isolation/src | grep -E "uc\.|check|constraint\.|cc\.|c\.name \?\? '" | wc -l` from `packages/` on 2026-11-17 (an over-count: some hits are unrelated `name` fields, e.g. lens constraints and columns);
- RENAME COLUMN's re-naming of a nameless UNIQUE's covering structure from `_uc_<old>` to `_uc_<new>` (memory and store), and the collision refusal that exists only because that name moves (`docs/sql-alter-rename.md` § RENAME COLUMN);
- `generateDefaultConstraintName` and the `_check_${index}` fallbacks in `core/derived-row-validator.ts` and `runtime/emit/materialized-view-helpers.ts`.

Wanted: `name: string` on `RowConstraintSchema`, `UniqueConstraintSchema` and `ForeignKeyConstraintSchema`, with the builders (`buildCheckConstraintSchema`, `buildUniqueConstraintSchema`, `buildForeignKeyConstraintSchema`) always returning a name, and every fallback above deleted. The compiler then lists every site that assumed a name could be missing. `CatalogUnnamedConstraint.name` likewise becomes required (still the unnamed *class* — `_`-prefixed — but always droppable).

Out of scope: lens constraint types and other non-table constraint shapes that happen to have an optional `name`.
