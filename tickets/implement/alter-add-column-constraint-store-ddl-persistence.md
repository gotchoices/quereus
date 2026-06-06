description: Persist column-level FK/CHECK added via ALTER TABLE ADD COLUMN into the store catalog DDL so the constraint survives rehydrateCatalog. Currently the store's addColumn arm persists a schema that omits the engine-merged column-level FK/CHECK, so after reopen orphan/violating inserts are accepted. Engine-side live enforcement already works; only persistence is broken.
files: packages/quereus-store/src/common/store-module.ts, packages/quereus/src/runtime/emit/alter-table.ts, packages/quereus/src/schema/constraint-builder.ts, packages/quereus/src/index.ts, packages/quereus-store/test/rehydrate-catalog.spec.ts
----

## Reproduction (confirmed)

A temporary spec (`packages/quereus-store/test/_repro-add-column-fk.spec.ts`, since removed)
exercised both arms against the in-memory provider used by `rehydrate-catalog.spec.ts`:

```
LIVE orphan rejected: true     REOPEN orphan rejected: false   (FK)
LIVE check rejected: true      REOPEN check rejected: false    (CHECK)
rehydrate errors: []           <- DDL re-parses cleanly; it simply omits the constraint
```

So the live session enforces the column-level FK/CHECK (the engine merged them into the
in-memory `SchemaManager`), but the persisted catalog DDL drops them, and after a fresh
`Database` + `rehydrateCatalog` the table is reconstructed without the constraint.

## Root cause

`runAddColumn` (`packages/quereus/src/runtime/emit/alter-table.ts`) extracts column-level
CHECK/FK from `columnDef.constraints` via the local helpers
`extractColumnLevelCheckConstraints` / `extractColumnLevelForeignKeys`, resolves the FK
child column to the freshly-added column index, and merges them into `enhancedTableSchema`,
which it registers in the in-memory `SchemaManager`. That merge happens **after**
`module.alterTable(...)` returns and is **never** handed back to the module.

The store's `addColumn` arm (`packages/quereus-store/src/common/store-module.ts`, ~L648-681)
builds `updatedSchema = { ...oldSchema, columns, columnIndexMap }` — appending only the
column — `table.updateSchema(updatedSchema)`, then `saveTableDDL(updatedSchema)`.
`generateTableDDL` faithfully serializes whatever constraints the schema carries
(`emitTableConstraints` already emits `checkConstraints` + `foreignKeys`), but
`updatedSchema` carries neither new constraint, so the persisted DDL omits them.

Contrast `addConstraint` (~L820-861), which explicitly builds the FK/UNIQUE into
`updatedSchema` and persists it — that path survives reopen (guarded by
`rehydrate-catalog.spec.ts`). ADD COLUMN has no equivalent plumbing.

## Design

Chosen shape: **option (a)** from the source ticket — the store extracts the column-level
FK/CHECK from `change.columnDef.constraints` and persists them — but with one critical
constraint discovered while tracing the engine flow:

> **The store must NOT return the constrained schema to the engine.**

`runAddColumn` re-merges the engine-extracted FK/CHECK on top of whatever
`module.alterTable` returns:

```
mergedForeignKeys = [...(updatedTableSchema.foreignKeys ?? []), ...resolvedForeignKeys]
mergedChecks      = [...updatedTableSchema.checkConstraints, ...newCheckConstraints]
```

If the store returned a schema that already contained the new FK/CHECK, the engine would
merge a **second** copy — duplicating the constraint in the live `SchemaManager` and, on the
next persist, in the DDL (so rehydrate would build two identical FKs). The engine remains the
single in-memory authority for ADD COLUMN; the store's job is **persistence only**.

Therefore the store builds two schema values in its `addColumn` arm:

- `updatedSchema` — column-only, exactly as today. This is what `table.updateSchema(...)`
  caches and what the arm **returns** to the engine (so the engine's merge is not doubled).
- `persistedSchema` — `updatedSchema` plus the extracted column-level CHECK/FK merged into
  `checkConstraints` / `foreignKeys`. This is what `saveTableDDL(...)` serializes.

The FK child-column index is resolved against the **post-add** column set — the new column
is appended last, so resolve via `updatedSchema.columnIndexMap.get(newColSchema.name.toLowerCase())`
(equivalently `updatedColumns.length - 1`), matching how the emit layer resolves
`resolvedForeignKeys`.

This is independent of the default kind: extraction reads the AST constraints regardless of
whether the DEFAULT folded to a literal or rides a per-row backfill evaluator, so the merge
must be **unconditional** (not gated on `defaultValue`). That covers the per-row
(evaluator-default) path automatically.

No existing-row validation is added in the store — the engine's `runAddColumn` already runs
`validateForeignKeyOverExistingRows` / the CHECK post-scan against the live (un-folded)
schema and reverts the column on violation; duplicating it here would be redundant and would
re-introduce the anti-join fold hazard the engine path deliberately avoids.

### DRY: share the extraction helpers

`extractColumnLevelCheckConstraints` / `extractColumnLevelForeignKeys` are currently local
to `alter-table.ts`. Move both into `packages/quereus/src/schema/constraint-builder.ts`
(already the single source of truth for AST→constraint-schema, already barrel-exported and
already consumed by the store), export them through `packages/quereus/src/index.ts`, and have
both `alter-table.ts` and the store import them. This keeps the store's extraction identical
to the engine's so the live and persisted constraint sets cannot drift.

- `constraint-builder.ts` will need `opsToMask` (for the CHECK mask) and the
  `RowConstraintSchema` / `ForeignKeyConstraintSchema` types from `./table.js`, plus
  `ColumnDef` from `../parser/ast.js`. Preserve the engine's behavior exactly, including the
  `fk.columns.length !== 1` mismatch error and the `columns: Object.freeze([])`
  caller-resolves contract (the store resolves to `[newColIdx]`; the engine continues to
  resolve via `columnIndexMap` as it does today).

### Persistence round-trip (already supported)

`generateTableDDL` → `emitTableConstraints` (ddl-generator.ts) already emits `checkConstraints`
and `foreignKeys` (including the engine's auto `_check_<col>` / `_fk_<col>` names), and the
existing ADD CONSTRAINT FK reopen test proves FK/CHECK round-trip cleanly through
rehydrate. No ddl-generator change is required — the fix is purely getting the constraints
into the schema the store persists.

## TODO

- Move `extractColumnLevelCheckConstraints` and `extractColumnLevelForeignKeys` from
  `runtime/emit/alter-table.ts` into `schema/constraint-builder.ts` and export them; update
  the imports in `alter-table.ts` (`opsToMask` is no longer needed there if nothing else uses
  it — verify before removing the import).
- Re-export both helpers from `packages/quereus/src/index.ts` (alongside the existing
  `buildUniqueConstraintSchema` / `buildForeignKeyConstraintSchema` line).
- In `store-module.ts` `addColumn` arm: import the two helpers from `@quereus/quereus`;
  after building the column-only `updatedSchema`, extract column-level CHECK/FK from
  `change.columnDef.constraints`, resolve each FK's `columns` to `[newColIdx]` (the new
  column's index in `updatedSchema`), and build a separate `persistedSchema` that merges them
  into `checkConstraints` / `foreignKeys`. Pass `persistedSchema` to `saveTableDDL(...)`;
  keep `table.updateSchema(updatedSchema)` and `return updatedSchema` on the column-only
  schema. Skip the extra schema entirely (persist `updatedSchema` directly) when there are no
  column-level CHECK/FK, to keep the common path unchanged.
- Add tests to `packages/quereus-store/test/rehydrate-catalog.spec.ts` mirroring the existing
  `FOREIGN KEY constraint survives reopen` / `CHECK constraint survives reopen` cases, but via
  `ALTER TABLE ADD COLUMN`:
  - ADD COLUMN with a column-level FK (`... references p(pid)`): after `rehydrateCatalog`, an
    orphan insert is rejected and a valid one succeeds. Use `PRAGMA foreign_keys = true` on
    both databases (as the existing FK test does).
  - ADD COLUMN with a column-level CHECK (`... check (qty > 0)`): after reopen, a violating
    insert is rejected and a satisfying one succeeds.
  - Include at least one case with a **per-row (non-foldable) DEFAULT** (e.g.
    `add column ... default (new.id) references p(pid)`) to prove persistence is not gated on
    a literal default. Confirm `result.errors` is empty (the re-parsed DDL must parse cleanly).
- Validate: `yarn workspace @quereus/quereus run build` (the helper move touches engine
  exports), then run the store test:
  `node --import ./packages/quereus-store/register.mjs node_modules/mocha/bin/mocha.js "packages/quereus-store/test/rehydrate-catalog.spec.ts" --reporter spec` from the repo root.
  Also run `yarn test` (memory path) to confirm the alter-table helper move didn't regress the
  engine ALTER tests, and `yarn workspace @quereus/quereus run lint`.
