----
description: Persist exposed-implicit-index user tags (`UniqueConstraintSchema.exposedIndexTags`) for store-backed tables by appending `ALTER INDEX … SET TAGS` statements to the table's catalog bundle and teaching `importDDL` to apply them silently on rehydrate.
prereq:
files:
  - packages/quereus/src/schema/ddl-generator.ts      # new generateIndexTagsDDL helper
  - packages/quereus/src/schema/manager.ts            # updateIndexTags refactor + silent importDDL arm
  - packages/quereus/src/schema/catalog.ts            # exposedImplicitIndexes (consumed, unchanged)
  - packages/quereus/src/index.ts                     # export exposedImplicitIndexes
  - packages/quereus-store/src/common/store-module.ts # buildCatalogEntry appends alter-index lines
  - packages/quereus-store/test/tag-persistence.spec.ts
  - packages/quereus-store/test/rehydrate-catalog.spec.ts
  - docs/schema.md                                    # close the gap notes (~lines 60, 95, 563)
  - packages/quereus-store/README.md                  # close the remaining-gap note (~line 50)
----

# Persist exposed-implicit-index user tags in the store catalog bundle

## Resolved design

A store-mode exposed implicit index (a non-derived UNIQUE constraint carrying
`quereus.expose_implicit_index = true`, NOT materialized in `tableSchema.indexes`)
keeps its user tags on `UniqueConstraintSchema.exposedIndexTags`
(`packages/quereus/src/schema/table.ts:648`). The store's catalog bundle
(`buildCatalogEntry`, `store-module.ts:1739`) is `CREATE TABLE` + one
`CREATE [UNIQUE] INDEX` per materialized index, newline-joined; the UNIQUE
constraint itself round-trips inside the CREATE TABLE (including `uc.tags`, hence
the exposure flag), but `exposedIndexTags` has no vehicle today.

**Vehicle (decided): append `ALTER INDEX … SET TAGS (…)` statements to the bundle.**
`ALTER INDEX <name> SET TAGS` is already a first-class statement: parsed
(`parser.ts` `alterIndexStatement` → `AST.AlterIndexStmt`), stringified
(`alterIndexToString` in `emit/ast-stringify.ts`), and applied by
`SchemaManager.updateIndexTags` whose store-mode fallback
(`manager.ts:1057-1079`, via `findExposedImplicitConstraintIndex` in `catalog.ts`)
routes onto `exposedIndexTags`. Reusing it keeps the persistence path on the
schema→AST-lift rendering (no hand-rolled serialization) and exactly mirrors how
the user applied the tags in the first place.

Rejected alternatives, for the record:
- *Synthetic `CREATE INDEX` line for the implicit index*: re-import would
  materialize a real `IndexSchema`, changing store-mode shape (the UC's implicit
  name would then be "materialized", `findExposedImplicitConstraintIndex` returns
  -1, and the store would start maintaining a structure it doesn't have).
- *Folding the tags into the UNIQUE constraint's `WITH TAGS`*: leaks index tags
  into `uc.tags`; the two records are deliberately separate (exposure flag vs
  surfaced index tags).

### Generation (engine + store)

New helper in `ddl-generator.ts`:

```ts
/** Canonical `alter index "<schema>"."<name>" set tags (...)` via AST-lift. */
export function generateIndexTagsDDL(
	schemaName: string | undefined,
	indexName: string,
	tags: Readonly<Record<string, SqlValue>>,
): string {
	const stmt: AST.AlterIndexStmt = {
		type: 'alterIndex',
		name: { type: 'identifier', name: indexName, schema: schemaName },
		action: { type: 'setTags', mode: 'replace', tags: { ...tags } },
	};
	return alterIndexToString(stmt);  // export from ast-stringify (currently module-private)
}
```

`alterIndexToString` is currently a private function in `ast-stringify.ts` reached
through the generic dispatcher — either export it or render via the existing
exported dispatcher entry point; prefer a direct named export to match the other
`*ToString` reuses (`createViewToString` etc.). It emits lowercase
(`alter index … set tags …`) while the table/index lines are uppercase — purely
cosmetic, `parser.parseAll` doesn't care; do not "fix" the casing.

`buildCatalogEntry` (store-module.ts) appends, after the index loop:

```ts
for (const desc of exposedImplicitIndexes(tableSchema)) {
	if (desc.tags && Object.keys(desc.tags).length > 0) {
		parts.push(generateIndexTagsDDL(tableSchema.schemaName, desc.name, desc.tags));
	}
}
```

`exposedImplicitIndexes(tableSchema)` (`catalog.ts:384`) already returns exactly
the right descriptors — non-derived, exposure-flagged, **not** materialized
(returns `[]` in memory mode), with `tags` read from `uc.exposedIndexTags` and
`name` from `implicitIndexName`. It needs re-exporting from
`packages/quereus/src/index.ts` (today only `isHiddenImplicitIndex` is exported,
line 143).

Emit always the whole-set `set tags` replace form (canonical, mirrors the
differ's whole-set convention); never emit a statement for an empty/absent tag
record (an empty record is stored as `undefined` by `freezeTags`, so
`desc.tags` is never `{}` in practice — the guard is defensive).

### Persistence trigger — already wired, no new plumbing

`ALTER INDEX … {SET|ADD|DROP} TAGS` on the exposed implicit index goes through
`updateIndexTags`'s fallback → `commitTagUpdate` (`manager.ts:690`), which fires
`table_modified` with the updated table as `newObject`. The store's existing
listener (`onEngineSchemaChange` → `persistCatalogIfChanged`,
`store-module.ts:2122`) regenerates the bundle from `newObject`; once
`buildCatalogEntry` includes the alter-index line, the bytes differ and the
entry re-persists. Confirmed: no new event or subscription needed. The write
rides `persistQueue`, drained by `closeAll`/`whenCatalogPersisted`.

### Import (engine)

`importDDL` (`manager.ts:~2426`) currently fail-louds on anything but
`createTable`/`createIndex`/`createView`/`createMaterializedView`. Add an
`alterIndex` arm that applies the tag action **silently** (no `notifyChange` —
import is contract-silent like `importTable`/`importIndex`; a stray
`table_modified` during rehydrate would be harmlessly compare-skipped by the
listener, but don't rely on that).

Implementation: factor the resolve-and-swap core out of `updateIndexTags`
(`manager.ts:1036+`) so both callers share the two-phase lookup (materialized
`IndexSchema` first, then the exposed-implicit-constraint fallback) and the
swapped-table construction; `updateIndexTags` commits via `commitTagUpdate`
(notify), the import path commits via plain `schema.addTable(newSchema)`
(silent). Reuse `freezeTags`/`mutateTagRecord` to map the
`AlterObjectTagsAction` to a `TagCompute` (support all three forms — replace /
merge / drop — even though the generator only emits replace; it's the same
helpers either way). Resolve the schema from `stmt.name.schema ??
getCurrentSchemaName()`, matching `buildAlterIndexStmt`.

The alter statement contributes **no entry** to `importDDL`'s results array (it
modifies an existing object rather than importing one), so `RehydrationResult`
counts stay meaningful. Adjust the result-collection loop to tolerate arms that
push nothing.

Ordering within a bundle is guaranteed by construction: the CREATE TABLE
(carrying the UC + exposure flag in its constraint `WITH TAGS`) precedes the
alter-index line, so `findExposedImplicitConstraintIndex` resolves against the
just-imported table. Keep the fail-loud contract for a target that doesn't
resolve — generator and bundle come from the same `TableSchema` snapshot, so an
unresolvable target indicates real corruption, which `rehydrateCatalog` already
records per-entry.

## Edge cases & interactions

- **Round-trip forms**: `SET TAGS`, `ADD TAGS`, `DROP TAGS` on the exposed
  implicit index each end in a normalized stored record; the bundle always
  carries one canonical whole-set `set tags` line. Verify each form survives
  close → reopen → `rehydrateCatalog` (check `uc.exposedIndexTags` on the
  rehydrated `TableSchema` and the `index_info()`/`schema()` surfaced tags).
- **Clear**: `SET TAGS ()` (and `DROP TAGS` of the last key) collapses to
  `undefined` (`freezeTags`) → no alter line in the regenerated bundle → bundle
  bytes change → re-persist → reopen shows no tags.
- **Hidden implicit index** (no exposure flag): `exposedImplicitIndexes` skips it
  → no alter line; it stays `NOTFOUND`-unaddressable after rehydrate exactly as
  before. Assert the bundle contains no `alter index` text for an unexposed UC.
- **Exposure flag dropped while `exposedIndexTags` is non-empty** (via
  `ALTER TABLE … ALTER CONSTRAINT … TAGS` removing
  `quereus.expose_implicit_index`): in-session the field lingers dormant and
  re-exposing resurrects the tags; the bundle (correctly) emits no alter line for
  an unexposed constraint — emitting one would make the import NOTFOUND-fail —
  so after reopen, re-exposing yields **no** tags. Accepted divergence; document
  it in the docs/schema.md note (it is the flip side of "tags are only
  addressable while exposed").
- **Multiple exposed UCs on one table**: one alter line each, in
  `uniqueConstraints` array order — bundle stays byte-deterministic (the
  compare-write and any diff-on-disk depend on this).
- **Structural ALTER no-double-write invariant**: `alterTable`'s own
  `saveTableDDL` and the follow-up `table_modified` listener pass must keep
  producing identical bytes (both call the same `buildCatalogEntry`); extend the
  existing put-count spy test (tag-persistence.spec.ts "structural ALTER does
  not produce a second write") to a table with a tagged exposed implicit index.
- **Column rename / table rename**: an unnamed UC's implicit name
  (`_uc_<cols>`) can change with a column rename; both the emitted name and the
  reopen-time resolution derive from the same `implicitIndexName(tableSchema, uc)`
  on the post-rename schema, so they cannot drift. Add a rename-then-reopen test.
- **DROP CONSTRAINT**: removes the UC → regenerated bundle loses the alter line
  with it (same snapshot), nothing stale persists.
- **Memory-backed tables in the same db**: never reach `buildCatalogEntry`
  (catalog-absent self-filter in `persistCatalogIfChanged`); also
  `exposedImplicitIndexes` returns `[]` for them (name materialized). No change.
- **Declarative differ**: operates on the live schema (canonical bodies exclude
  tags), not on the stored bundle text — rehydration merely restores the same
  in-memory state a live session had, so no new differ behavior. Sanity-check
  with the existing diff-after-rehydrate pattern (`diff schema main` → 0 rows)
  on a declared table whose UC is exposed and tagged.
- **`importDDL` fail-loud contract**: unsupported statement types must still
  throw; only `alterIndex` gains an arm. An `alterIndex` targeting a
  nonexistent/unexposed index still throws NOTFOUND (recorded per-entry by
  `rehydrateCatalog`, not fatal to other entries).

## TODO

- Export `alterIndexToString` from `emit/ast-stringify.ts` (named export, like
  `createViewToString`).
- Add `generateIndexTagsDDL(schemaName, indexName, tags)` to
  `schema/ddl-generator.ts` (AST-lift, no catalog.ts import — keeps layering
  acyclic).
- Export `exposedImplicitIndexes` (and its `SyntheticExposedIndex` type) from
  `packages/quereus/src/index.ts`.
- Refactor `SchemaManager.updateIndexTags` to extract the shared
  resolve-and-swap core; add the silent import-side applier.
- Add the `alterIndex` arm to `importDDL` (silent apply, no result entry,
  all three tag-action forms via existing `freezeTags`/`mutateTagRecord`).
- Append alter-index lines in `StoreModule.buildCatalogEntry` for
  `exposedImplicitIndexes(tableSchema)` descriptors with non-empty tags; update
  its doc comment (bundle = table DDL + index DDL + exposed-implicit-index tag
  DDL).
- Tests (quereus-store): tag-persistence.spec.ts and/or rehydrate-catalog.spec.ts —
  - set/add/drop tags on an exposed implicit index → `whenCatalogPersisted` →
    reopen → rehydrate → tags identical (and surfaced via `index_info()`);
  - clear-tags round-trip (no tags after reopen);
  - unexposed UC: bundle contains no `alter index` line;
  - bundle byte-determinism + structural-ALTER single-write spy with a tagged
    exposed implicit index;
  - column-rename (unnamed UC) then reopen: tags follow the renamed implicit
    index name;
  - drop-exposure-then-reopen divergence pinned (re-expose after reopen → no
    tags).
- Docs: docs/schema.md — rewrite the three gap mentions (≈ lines 60, 95, 563):
  the exposed-implicit-index tag gap is closed (describe the alter-index bundle
  line + silent import); line 563's stale "index and view/MV tag persistence is
  still pending — backlog `store-secondary-index-persistence` /
  `store-view-mv-persistence`" is wrong on all counts now — fix it. Document the
  drop-exposure divergence. packages/quereus-store/README.md — remove the
  "only remaining gap" sentence (≈ line 50) and fold the bundle's alter-index
  line into the catalog-persistence description.
- `yarn build`, `yarn workspace @quereus/quereus run lint`, `yarn test`; run the
  quereus-store suite (it runs under `yarn test` workspaces) — `test:store` only
  if a store-path question arises.
