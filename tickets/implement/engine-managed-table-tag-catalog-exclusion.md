description: Add a reserved tag that lets the engine mark a table as engine-owned so the "apply schema" / "diff schema" comparison ignores it instead of trying to drop it. Without this, an engine-driven module (Lamina's lens layer) registers helper tables that a plain re-apply mistakes for orphans and tries to delete, which crashes.
prereq:
files:
  - packages/quereus/src/schema/reserved-tags.ts (ENGINE_MANAGED_TABLE_TAG constant + ReservedTagSpec + suggestion list)
  - packages/quereus/src/schema/catalog.ts (collectSchemaCatalog skip + isEngineManagedTable helper)
  - packages/quereus/src/index.ts (re-export ENGINE_MANAGED_TABLE_TAG from the package entry)
  - packages/quereus/test/schema/reserved-tags.spec.ts (count + validation coverage)
  - packages/quereus/test/schema/catalog.spec.ts (exclusion coverage)
difficulty: easy
----

# `quereus.engine_managed` reserved tag — exclude engine-synthesized tables from the declarative diff

## Status: implemented + validated, AWAITING COMMIT on this board

The full change described below is **already present (uncommitted) in this
working tree** and has been validated. It was authored by the cross-repo
lamina ticket `quereus-lens-member-relations-basis-catalog` (lamina is the
consumer; the lamina runner commits only the lamina repo, so this engine-core
half must be committed here). **A reviewer on this board should: read the diff,
confirm it stands alone, and commit it** — not re-implement it.

The five files this ticket owns (see `files:` above) are the ONLY ones it should
touch. The working tree may carry other unrelated in-flight edits (e.g. the
array-scalar-param ticket) — do **not** sweep those into this commit.

## Why

An engine-driven module can register real, engine-resolvable tables into a
physical schema's `Schema` that are NOT user-declared objects. The motivating
producer is Lamina's lens basis layer: each per-column cell store is exposed as a
`(rowId, value)` basis relation named `<table>__col_<col>` and registered into the
basis scope's `Schema` (so the lens compiler's `resolveBasisRelation` finds it).
Those relations land in the SAME `Schema.getAllTables()` map `collectSchemaCatalog`
walks for `apply schema` / `diff schema`. The declared basis carries only domain
tables, so the differ sees each `<table>__col_*` as an orphan absent from the
declaration and emits a `DROP TABLE … <table>__col_*`. The drop then throws
(`alterTable: '<basis>.<table>__col_*' not declared`) because a member is a
substrate cell store, not a relational-catalog row. A bare in-place
`apply schema <basis>` over a deployed lens trio therefore crashes.

This is the engine-managed-table sibling of the implicit-covering-index exclusion
(`CatalogIndex.implicit`, filtered in `computeSchemaDiff`'s `actualIndexes`): an
engine-synthesized backing surfaced for resolution but excluded from the
user-visible declarative diff.

## The change

**`reserved-tags.ts`**
- Export `ENGINE_MANAGED_TABLE_TAG = 'quereus.engine_managed'` with a doc comment
  modeled on `EXPOSE_IMPLICIT_INDEX_TAG`.
- Add a `ReservedTagSpec`: `sites: ['physical-table']`, `valueSchema: 'boolean'`.
- Add `quereus.engine_managed` to the `unknownReservedTag` suggestion list.

**`catalog.ts`**
- Add `isEngineManagedTable(tableSchema)` → `tableSchema.tags?.[ENGINE_MANAGED_TABLE_TAG] === true`.
- In `collectSchemaCatalog`'s `for (const tableSchema of schema.getAllTables())`
  loop, `continue` when engine-managed — placed BEFORE the maintained / isView
  branches so it is excluded unconditionally. Excluding at collection time (not in
  the differ) keeps it out of every catalog consumer in one place; only
  `apply schema` / `diff schema` consume `collectSchemaCatalog`, so the scoping is
  exact. The table stays resolvable via `getTable` / `getAllTables` everywhere else.

**`index.ts`**
- Re-export `ENGINE_MANAGED_TABLE_TAG` alongside `SYNC_REPLICATE_TAG` etc. so the
  producing module (`lamina-quereus`) imports the constant rather than re-spelling
  the literal.

## Acceptance

- `reserved-tags.spec.ts`: `RESERVED_TAGS` length 20; `quereus.engine_managed`
  present; accepts boolean at `physical-table`, rejects non-boolean / wrong site /
  typo. (Added.)
- `catalog.spec.ts`: an `engine_managed = true` table is excluded from
  `collectSchemaCatalog` yet resolvable via `getTable`; `= false` stays included.
  (Added.)
- Existing `schema-differ.spec.ts` / `declarative-equivalence.spec.ts` /
  `exports.spec.ts` still pass.

Validated locally via:
`node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js "packages/quereus/test/schema/reserved-tags.spec.ts" "packages/quereus/test/schema/catalog.spec.ts" "packages/quereus/test/schema-differ.spec.ts" "packages/quereus/test/exports.spec.ts" "packages/quereus/test/declarative-equivalence.spec.ts"`
→ 299 passing.

## Cross-ref

Consumer + regression test: lamina `quereus-lens-member-relations-basis-catalog`
(the lamina-side tag stamp in `basis-member-registration.ts` + the e2e
`lens-basis-inplace-reapply-keeps-members-e2e.test.ts`). The lamina commit is safe
to land first: until this engine-core commit lands, the lamina tag stamp imports
`ENGINE_MANAGED_TABLE_TAG` from `@quereus/quereus`, so lamina's build/typecheck
needs this export present in a built `dist/` — coordinate the two commits, or
rebuild quereus `dist` from this checkout.
