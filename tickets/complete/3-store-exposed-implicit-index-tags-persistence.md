----
description: Persist exposed-implicit-index user tags (`UniqueConstraintSchema.exposedIndexTags`) for store-backed tables — `alter index … set tags` lines appended to the catalog bundle, re-applied silently by `importDDL` on rehydrate. Reviewed and complete.
files:
  - packages/quereus/src/emit/ast-stringify.ts          # alterIndexToString now a named export
  - packages/quereus/src/schema/ddl-generator.ts        # generateIndexTagsDDL (AST-lift over alterIndexToString)
  - packages/quereus/src/schema/manager.ts              # resolveIndexTagSwap extraction; importDDL alterIndex arm; applyImportedIndexTags
  - packages/quereus/src/index.ts                       # exports: generateIndexTagsDDL, exposedImplicitIndexes, SyntheticExposedIndex
  - packages/quereus-store/src/common/store-module.ts   # buildCatalogEntry appends alter-index tag lines
  - packages/quereus-store/src/common/index.ts          # re-exports generateIndexTagsDDL (review fix)
  - packages/quereus-store/test/tag-persistence.spec.ts # 11 tests (8 implement + 3 review)
  - docs/schema.md                                      # gap notes closed; DDL Generation sample updated (review fix)
  - packages/quereus-store/README.md                    # remaining-gap sentence removed; bundle description updated
----

# Complete: persist exposed-implicit-index user tags in the store catalog bundle

## What was built

A store-mode exposed implicit index (non-derived UNIQUE constraint tagged
`quereus.expose_implicit_index = true`, never materialized in
`tableSchema.indexes`) keeps its user tags on
`UniqueConstraintSchema.exposedIndexTags`. Those tags previously had no
persistence vehicle. Now:

- **Generation**: `StoreModule.buildCatalogEntry` appends one
  `alter index <schema>.<name> set tags (…)` line per
  `exposedImplicitIndexes(tableSchema)` descriptor with non-empty tags, after
  the `CREATE [UNIQUE] INDEX` lines. The line is rendered by
  `generateIndexTagsDDL(schemaName, indexName, tags)` in
  `schema/ddl-generator.ts` — a schema→AST lift over the (newly exported)
  `alterIndexToString` emitter, so the persisted form is byte-identical to a
  live `ALTER INDEX … SET TAGS` rendering. Always the whole-set replace form;
  empty/absent records emit no line. The emitter is lowercase while CREATE
  lines are uppercase — cosmetic, deliberate.
- **Persistence trigger**: no new plumbing. The live ALTER routes through
  `updateIndexTags`'s exposed-constraint fallback → `commitTagUpdate` →
  `table_modified` → the store's existing `persistCatalogIfChanged`
  compare-write, which regenerates the bundle.
- **Import**: `importDDL` gained an `alterIndex` arm that applies the tag
  action **silently** (no `notifyChange`, mirroring `importTable`) via
  `applyImportedIndexTags`, contributing no entry to the import results. The
  resolve-and-swap core was extracted from `updateIndexTags` into
  `resolveIndexTagSwap` (materialized `IndexSchema` first, then
  exposed-implicit-constraint fallback); the live path commits with notify,
  the import path with plain `schema.addTable`. All three action forms
  (replace / merge / drop) map through the shared
  `freezeTags`/`mutateTagRecord`. Unresolvable targets throw NOTFOUND
  (fail-loud; `rehydrateCatalog` records per-entry).

One deliberate divergence (documented in docs/schema.md): tags are only
persisted while the constraint is exposed — dropping the exposure flag leaves
`exposedIndexTags` dormant in-session (re-exposing resurrects it), but the
bundle emits no line for an unexposed constraint, so a reopen taken while
unexposed loses the tags.

## Review findings

**Process**: read the implement diff first with fresh eyes, then traced every
touched path in current source (`resolveIndexTagSwap` both arms,
`applyImportedIndexTags` narrowing, `buildCatalogEntry`,
`persistCatalogIfChanged`, `rehydrateCatalog` error isolation,
`exposedImplicitIndexes` / `findExposedImplicitConstraintIndex`), ran
`yarn build`, `yarn workspace @quereus/quereus run lint`, and the full
`yarn test` (twice — before and after review fixes). All pass: 5,590 engine +
426 quereus-store (423 → 426 with the review tests) + all other workspaces.

**Checked, found sound (no action):**

- *Extraction fidelity*: `resolveIndexTagSwap` preserves the prior inline
  semantics exactly — compute-before-swap ordering in both arms (a
  drop-of-absent NOTFOUND aborts untouched), hidden-implicit skip, NOTFOUND
  fallthrough.
- *Quoting / round-trip safety of the persisted line*: `generateIndexTagsDDL`
  renders the name through `expressionToString`'s identifier case →
  `quoteIdentifier` on both schema and index name (keywords and
  invalid-identifier names get quoted), and `tagsBodyToString` quotes keys and
  escapes string values — a constraint named e.g. `"my uc"` round-trips.
- *Type narrowing*: the `AlterObjectTagsAction` union is narrowed correctly in
  `applyImportedIndexTags` (dropTags checked before reading `.mode`).
- *Docs accuracy*: the new docs/schema.md claim that real-index tags ride the
  `CREATE INDEX` line was verified against `generateIndexDDL` (it emits
  `WITH TAGS`); the tag-drift and store-persistence sections match the code.
- *No other bundle consumers*: catalog entries are parsed only by
  `SchemaManager.importCatalog` via `rehydrateCatalog`; quereus-sync and the
  isolation layer treat store bytes opaquely, so the new statement kind in the
  bundle breaks nothing downstream.
- *Per-entry error isolation*: an errored bundle is recorded in
  `RehydrationResult.errors` without aborting the rest (verified by code and
  by a new test).
- *No stale tickets*: no backlog ticket still references the closed gap.

**Minor findings, fixed in this pass:**

- The implement handoff flagged three untested paths; all three now have
  tests in `tag-persistence.spec.ts`:
  - *Merge/drop import arms*: hand-crafted `add tags` / `drop tags` lines
    written directly into the catalog bytes exercise the two
    `applyImportedIndexTags` arms the generator never emits; tags resolve to
    the expected merged/dropped set after reopen.
  - *Corruption path*: an `alter index` line whose target resolves nowhere
    records exactly one per-entry rehydrate error (NOTFOUND naming the index);
    the test also pins partial-import behavior — the `CREATE TABLE` earlier in
    the same bundle has already registered (import is not transactional), and
    only the result tally skips the errored entry.
  - *Multiple exposed UCs on one table*: each constraint persists its own
    line, in `uniqueConstraints` array order (byte-determinism), and both
    round-trip independently.
- docs/schema.md § DDL Generation's export sample omitted the new
  `generateIndexTagsDDL` — added.
- `@quereus/store`'s DDL-generator re-export (`src/common/index.ts`) omitted
  `generateIndexTagsDDL`, contradicting the docs' "re-exports these symbols"
  claim — added.

**Noted, deliberately not pursued (pre-existing / out of scope):**

- `tagValueToString` stringifies bigint via `String()` (numeric round-trip,
  type degraded) and would mangle a blob — shared behavior of *all* existing
  tag persistence (`WITH TAGS` on tables/columns/indexes), not introduced
  here; SQL-authored tags are literal-only so blob is unreachable.
- `yarn test:store` (LevelDB logic-test path) was not run — no store-path
  question arose; the store package's own suite covers all new code paths.

**Major findings**: none — no new tickets spawned.
