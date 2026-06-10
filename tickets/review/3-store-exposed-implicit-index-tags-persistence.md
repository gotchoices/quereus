----
description: Review the persistence of exposed-implicit-index user tags (`UniqueConstraintSchema.exposedIndexTags`) for store-backed tables — `alter index … set tags` lines appended to the catalog bundle, re-applied silently by `importDDL` on rehydrate.
prereq:
files:
  - packages/quereus/src/emit/ast-stringify.ts          # alterIndexToString now a named export
  - packages/quereus/src/schema/ddl-generator.ts        # new generateIndexTagsDDL (AST-lift over alterIndexToString)
  - packages/quereus/src/schema/manager.ts              # resolveIndexTagSwap extraction; importDDL alterIndex arm; applyImportedIndexTags
  - packages/quereus/src/index.ts                       # exports: generateIndexTagsDDL, exposedImplicitIndexes, SyntheticExposedIndex
  - packages/quereus-store/src/common/store-module.ts   # buildCatalogEntry appends alter-index tag lines; doc comments
  - packages/quereus-store/test/tag-persistence.spec.ts # 8 new tests
  - docs/schema.md                                      # gap notes closed (~lines 60, 95, 217-240, 563)
  - packages/quereus-store/README.md                    # remaining-gap sentence removed; bundle description updated
----

# Review: persist exposed-implicit-index user tags in the store catalog bundle

## What was built

A store-mode exposed implicit index (non-derived UNIQUE constraint tagged
`quereus.expose_implicit_index = true`, never materialized in
`tableSchema.indexes`) keeps its user tags on
`UniqueConstraintSchema.exposedIndexTags`. Those tags previously had no
persistence vehicle. Now:

- **Generation**: `StoreModule.buildCatalogEntry` appends one
  `alter index <schema>.<name> set tags (…)` line per
  `exposedImplicitIndexes(tableSchema)` descriptor with non-empty tags, after
  the `CREATE [UNIQUE] INDEX` lines. The line is rendered by the new
  `generateIndexTagsDDL(schemaName, indexName, tags)` in
  `schema/ddl-generator.ts` — a schema→AST lift over the (newly exported)
  `alterIndexToString` emitter, so the persisted form is byte-identical to a
  live `ALTER INDEX … SET TAGS` rendering. Always the whole-set replace form;
  empty/absent records emit no line. The emitter is lowercase while CREATE
  lines are uppercase — cosmetic, deliberate, do not "fix".
- **Persistence trigger**: no new plumbing. The live ALTER routes through
  `updateIndexTags`'s exposed-constraint fallback → `commitTagUpdate` →
  `table_modified` → the store's existing `persistCatalogIfChanged`
  compare-write, which regenerates the bundle (bytes now differ → re-persist).
- **Import**: `importDDL` gained an `alterIndex` arm that applies the tag
  action **silently** (no `notifyChange`, mirroring `importTable`) via the new
  `applyImportedIndexTags`, and contributes **no entry** to the import results
  (it modifies an existing object). The resolve-and-swap core was extracted
  from `updateIndexTags` into `resolveIndexTagSwap` (materialized `IndexSchema`
  first, then exposed-implicit-constraint fallback); the live path commits with
  notify, the import path with plain `schema.addTable`. All three action forms
  (replace / merge / drop) map through the existing
  `freezeTags`/`mutateTagRecord`, though the generator only emits replace.
  Unresolvable targets still throw NOTFOUND (fail-loud; `rehydrateCatalog`
  records per-entry). Schema resolves from `stmt.name.schema ??
  getCurrentSchemaName()`, matching `buildAlterIndexStmt`.

## Validation performed

`yarn build` (all packages), `yarn workspace @quereus/quereus run lint`, and
the full `yarn test` all pass (5,590 engine + 420 quereus-store + all other
workspaces; the quereus-store count includes the 8 new tests). `yarn test:store`
was NOT run (ticket said only if a store-path question arises) — a reviewer
wanting belt-and-braces coverage of the LevelDB logic-test path can run it.

New tests in `packages/quereus-store/test/tag-persistence.spec.ts`:

- SET TAGS round-trip: close → reopen → rehydrate → `exposedIndexTags`
  identical; exposure flag stays on `uc.tags` (no leak); surfaced via
  `schema()` TVF; bundle contains the `alter index main.uq_vin set tags (`
  line.
- ADD TAGS / DROP TAGS normalize into the persisted whole-set form and
  round-trip.
- Clear (`SET TAGS ()`): alter line disappears from the bundle; reopen shows
  `undefined`.
- Unexposed UC: bundle contains no `alter index` text.
- Structural ALTER (ADD COLUMN) with a tagged exposed implicit index: exactly
  one catalog put (the module's own `saveTableDDL` and the follow-up
  `table_modified` listener pass produce identical bytes — pins bundle
  byte-determinism across the two generation paths).
- Column rename with an **unnamed** UC (`_uc_vin` → `_uc_chassis`): emitted
  name and reopen-time resolution both derive from the post-rename schema;
  tags follow, and the renamed implicit name stays addressable after reopen.
- Drop-exposure divergence **pinned**: in-session, dropping
  `quereus.expose_implicit_index` leaves the tags dormant and re-exposing
  resurrects them; the bundle (correctly) emits no line for an unexposed
  constraint, so re-exposing after a reopen taken while unexposed yields no
  tags. This is the accepted divergence from the ticket, now documented in
  docs/schema.md.
- Declarative differ: converged `declare schema` + rehydrated tagged exposed
  implicit index → `diff schema main` = 0 rows (no phantom index ops).

## Known gaps / reviewer notes

- **Merge/drop through the import path are untested end-to-end.** The
  generator only ever emits the replace form, so rehydrate exercises only
  that arm of `applyImportedIndexTags`; the merge/drop mappings are the same
  shared helpers the live ALTER tests cover, but no test feeds a hand-crafted
  bundle containing `add tags`/`drop tags` lines through `importDDL` (it is
  private; one could write such bytes directly into the catalog store).
- **Corruption path untested**: an `alter index` line whose target doesn't
  resolve should NOTFOUND-fail per-entry in `rehydrateCatalog` — verified by
  code inspection only (generator and bundle come from one snapshot, so it is
  unreachable without corruption).
- **Multiple exposed UCs on one table** not explicitly tested; ordering is by
  `uniqueConstraints` array order by construction (byte-determinism for the
  single-UC case is pinned by the put-count spy test).
- DROP CONSTRAINT / memory-backed-table no-ops were reasoned from existing
  self-filters (`persistCatalogIfChanged` catalog-absent skip;
  `exposedImplicitIndexes` returns `[]` when the name is materialized) and are
  covered by pre-existing tests, not new ones.

## Use cases to validate during review

```sql
create table t (id integer primary key, vin text,
  constraint uq_vin unique (vin) with tags ("quereus.expose_implicit_index" = true)) using store;
insert into t values (1, 'v1');
alter index uq_vin set tags (purpose = 'lookup');
-- close, reopen, rehydrateCatalog →
-- findTable('t').uniqueConstraints[0].exposedIndexTags = { purpose: 'lookup' }
-- select tags from schema() where type='index' and name='uq_vin' → surfaced
```

Catalog bundle shape after the ALTER:

```
CREATE TABLE "main"."t" (…, CONSTRAINT "uq_vin" UNIQUE ("vin") WITH TAGS ("quereus.expose_implicit_index" = TRUE)) USING store
alter index main.uq_vin set tags (purpose = 'lookup')
```
