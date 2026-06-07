description: Make an exposed implicit covering index (quereus.expose_implicit_index) addressable + introspectable in store mode by deriving it from uniqueConstraints in the schema()/index_info()/catalog read paths and the ALTER INDEX … TAGS write path — without materializing a phantom index in the store.
files:
  - packages/quereus/src/schema/catalog.ts (implicitCoveringIndexExposure ~289; isHiddenImplicitIndex ~310; collectSchemaCatalog index loop ~145-152 — add shared descriptor helper here)
  - packages/quereus/src/func/builtins/schema.ts (schema() TVF index loop ~113-143; index_info() TVF ~370-390 — both read tableSchema.indexes directly)
  - packages/quereus/src/schema/manager.ts (updateIndexTags ~1017-1050 — write path; add constraint fallback)
  - packages/quereus/src/schema/table.ts (UniqueConstraintSchema ~565-606 — add exposedIndexTags field)
  - packages/quereus/src/vtab/memory/layer/manager.ts (ensureUniqueConstraintIndexes ~197-240 — memory's materialized entry; reference for descriptor shape, NOT changed)
  - packages/quereus/test/logic/50-metadata-tags.sqllogic (Phase 38 ~1059-1080 — the failing case)
  - packages/quereus-store/src/common/store-table.ts (updateSecondaryIndexes ~948-975 — DO NOT materialize: this loop opens a KV store per index)
  - packages/quereus-store/src/common/store-module.ts (buildCatalogEntry ~1473 — unaffected by direction A; note for the differ/persistence TODO)
effort: high
----

## Goal

Make the *exposed* implicit covering index of a declared UNIQUE constraint —
the one opted in via `quereus.expose_implicit_index = true` — addressable
(`ALTER INDEX … {SET|ADD|DROP} TAGS`) and introspectable (`schema()`,
`index_info()`) in **store mode**, matching memory mode. This fixes the single
failing case in `yarn test:store`: `50-metadata-tags.sqllogic` Phase 38.

The originating fix-stage research (now deleted) is fully captured below;
nothing further needs re-discovery.

## Background — why the two backends differ

The whole feature is built around the implicit covering index existing as a
concrete `IndexSchema` entry in `tableSchema.indexes`:

- **Memory mode** materializes it. `MemoryTableLayerManager.ensureUnique`-
  `ConstraintIndexes` (`vtab/memory/layer/manager.ts:197`) appends an
  `IndexSchema` named `uc.name ?? '_uc_<cols>'` to `tableSchema.indexes` for
  every UNIQUE constraint (the covering BTree is the enforcement mechanism), and
  that augmented schema reaches the SchemaManager registry. So `uq_expo_vin` is a
  real (hidden-by-default) index entry; the exposure tag flips it visible.
- **Store mode** materializes *none*. `buildTableSchemaFromAST`
  (`manager.ts:1492`) populates `tableSchema.uniqueConstraints` but the store
  enforces UNIQUE by full-scan over `uniqueConstraints` at write time and
  reserves `tableSchema.indexes` for *real persistent* secondary index stores.
  So in store mode `uq_expo_vin` exists only as a `UniqueConstraintSchema`,
  never as an `IndexSchema`.

Every read/write path keys off `tableSchema.indexes`:

- `schema()` TVF — `func/builtins/schema.ts:113-143` iterates
  `tableSchema.indexes` directly (NOT `collectSchemaCatalog`) and yields each as
  a `type='index'` row. **This is the read path the failing `SELECT` uses.**
- `index_info()` TVF — `func/builtins/schema.ts:370-390` iterates
  `tableSchema.indexes` directly.
- `collectSchemaCatalog` — `schema/catalog.ts:145-152` iterates
  `tableSchema.indexes`, consulting `implicitCoveringIndexExposure` for
  visibility (drives `export_schema` / the declarative differ).
- `updateIndexTags` — `schema/manager.ts:1017-1050` scans `tableSchema.indexes`
  for a name match; not found ⇒ `NOTFOUND`. Tags are stored *on the matched
  `IndexSchema`*.

In store mode the index is absent from `tableSchema.indexes`, so the write path
throws `NOTFOUND` (the observed failure) and all three read paths never surface
it.

## Decision — Direction A (route through `uniqueConstraints`); reject Direction B

**Chosen: A.** For backends that do not materialize the implicit covering index
(store), *derive* a synthetic exposed index from each exposed
`UniqueConstraintSchema` in the read paths, and route its tags onto the
constraint in the write path. The store's physical model is untouched: it keeps
enforcing UNIQUE via full-scan over `uniqueConstraints`, creates no implicit
index KV store, and the query planner is never offered a non-existent index.

**Rejected: B — store materializes a phantom `IndexSchema`.** The store iterates
`tableSchema.indexes` in its DML hot path: `store-table.ts:948`
`updateSecondaryIndexes` calls `ensureIndexStore(index.name)` for *every* entry,
so a synthesized implicit index would (a) open a real KV index store and
double-maintain it on every INSERT/UPDATE/DELETE against the full-scan UNIQUE
enforcement the store actually uses, and (b) be a "phantom index" the store must
exclude everywhere it walks `tableSchema.indexes` — DML maintenance, the
connect/reopen reattach path, `buildIndexEntries`, and crucially
`bestAccessPlan`, where the planner could route an equality lookup on the
indexed column to an index store that does not exist → runtime failure. That is
a broad, error-prone surface with a real correctness hazard. Direction A
confines the change to backend-agnostic engine read/write code.

Trade-off accepted: A produces an **asymmetric tag home** — memory keeps the
exposed index's user tags on its materialized `IndexSchema.tags`; store keeps
them on the constraint (a new `UniqueConstraintSchema.exposedIndexTags` field).
The asymmetry is internal; observable behavior (`schema()`/`index_info()` rows,
`ALTER INDEX … TAGS`) is identical across backends. This is preferable to
mutating memory's working paths (regression risk on Phase 22/37/38) or to the
phantom-index hazard of B.

## Design

### New schema state

Add to `UniqueConstraintSchema` (`schema/table.ts`):

```ts
/**
 * User-addressable tags for this constraint's *exposed* implicit covering index
 * (the one opted into catalog visibility via `quereus.expose_implicit_index`).
 * Kept SEPARATE from `tags` (which holds the exposure flag + constraint tags) so
 * the exposure flag never leaks into the surfaced index tags and the differ can
 * treat the two independently. Only consulted for backends that do NOT
 * materialize the implicit index as an `IndexSchema` (i.e. the store); in memory
 * mode the tags live on the materialized `IndexSchema.tags` instead.
 */
exposedIndexTags?: Readonly<Record<string, SqlValue>>;
```

### Shared descriptor helper (catalog.ts)

Add an exported helper next to `implicitCoveringIndexExposure` /
`isHiddenImplicitIndex`:

```ts
export interface SyntheticExposedIndex {
  name: string;
  columns: ReadonlyArray<IndexColumnSchema>; // mirror ensureUniqueConstraintIndexes: per-column collation
  predicate?: Expression;                    // from uc.predicate
  tags?: Readonly<Record<string, SqlValue>>; // from uc.exposedIndexTags
  // NOTE: deliberately NO `unique` flag — mirrors the memory materialized entry
  // (ensureUniqueConstraintIndexes does not set unique; enforcement routes via
  // uniqueConstraints), so index_info()'s `unique` column matches across backends.
}

/**
 * Exposed implicit covering indexes that are NOT already materialized in
 * tableSchema.indexes — i.e. the store-mode case. For each non-derived UNIQUE
 * constraint carrying quereus.expose_implicit_index=true whose implicit name
 * (`uc.name ?? '_uc_<cols>'`) is absent from tableSchema.indexes, returns a
 * descriptor the read paths can surface and updateIndexTags can target.
 *
 * Returns empty for memory-mode tables (the name is already materialized), so
 * callers can append unconditionally with no risk of double-listing.
 */
export function exposedImplicitIndexes(tableSchema: TableSchema): SyntheticExposedIndex[]
```

Implementation: reuse the same name derivation (`uc.name ?? '_uc_<cols>'`) and
exposure check already in `implicitCoveringIndexExposure`; skip
`derivedFromIndex` constraints; skip any name already present (case-insensitive)
in `tableSchema.indexes`; build `columns` exactly like
`ensureUniqueConstraintIndexes` (`{ index, collation: column.collation }`).

### Read-path wiring (all three)

After each site finishes iterating the real `tableSchema.indexes`, also iterate
`exposedImplicitIndexes(tableSchema)` and emit identically:

- `schema.ts` `schema()` TVF (~143): yield a `type='index'` row per descriptor
  (`tags = tagsToJson(desc.tags)`; reuse the same `CREATE INDEX "…" ON …`
  string-build, which only reads name/columns/collation/desc).
- `schema.ts` `index_info()` TVF (~390): emit one row per descriptor column,
  same shape (`unique=0`, `partial = desc.predicate ? 1 : 0`).
- `catalog.ts` `collectSchemaCatalog` (~152): push an
  `indexSchemaToCatalog`-equivalent `CatalogIndex` per descriptor (build the
  `IndexSchema`-shaped object inline or factor `indexSchemaToCatalog` to accept
  the descriptor; `definition`/`ddl` derive from columns/predicate the same way).

In memory mode `exposedImplicitIndexes` returns `[]`, so these sites are
unchanged there (the materialized entry continues to be surfaced by the existing
`tableSchema.indexes` loop). Do NOT touch hidden-implicit visibility in
`schema()`/`index_info()` — that is pre-existing behavior out of scope here.

### Write-path wiring (updateIndexTags)

In `manager.ts` `updateIndexTags` (~1017): when no `IndexSchema` matches across
`schema.getAllTables()` (the current `NOTFOUND` branch), fall back to searching
for a table with an exposed implicit constraint whose implicit name matches
`indexName`. On a match:

1. `nextTags = compute(uc.exposedIndexTags)` (same `TagCompute` contract — so
   `setIndexTags` replaces, `mergeIndexTags` merges, `dropIndexTags` requires
   every key present, all unchanged).
2. Rebuild `uniqueConstraints` with that one constraint's `exposedIndexTags`
   swapped to `nextTags` (drop the field when the record becomes empty), freeze,
   `schema.addTable(updatedTableSchema)`, and fire the same `table_modified`
   notification.

Keep the existing `IndexSchema` path first so memory mode is unchanged. Preserve
the rule that a *hidden* implicit index (exposure flag false / absent) stays
`NOTFOUND` — only the *exposed* constraint is a valid fallback target. Reuse the
catalog helper(s) (`isHiddenImplicitIndex` / the new descriptor derivation) so
the name/exposure logic is not re-implemented.

## Validation

- Primary: from `packages/quereus`, `node test-runner.mjs --store --grep
  "50-metadata-tags"` — Phase 38 (and the whole file) must pass. Reproduces the
  exact failure today: `QuereusError: Index 'uq_expo_vin' not found in schema
  'main'` at `updateIndexTags`.
- Parity: `yarn test --grep "50-metadata-tags"` (memory) must stay green —
  confirms the memory path is untouched (Phase 22 hidden SET, Phase 37 hidden
  ADD/DROP NOTFOUND, Phase 38 exposed ADD/DROP).
- Broader: `yarn test` (memory, full) green; then `yarn test:store` — the suite
  was 5184 passing / 14 pending / **1 failing** (only this) at the flagging SHA;
  target 0 failing. Stream output (`… 2>&1 | tee /tmp/x.log; tail -n 80
  /tmp/x.log`) per AGENTS.md.

## Notes / scope boundaries for the reviewer

- **Tag persistence across reopen is a documented gap, not in scope.** With the
  separate `exposedIndexTags` field, the table DDL's `WITH TAGS` emits only the
  constraint's `tags` (the exposure flag), so an exposed index's user tags do
  not survive close→reopen in store mode. Phase 38 does not reopen, so this does
  not block the fix. Store index-tag persistence is already partially pending
  (see `quereus-store/README.md` § Catalog DDL re-persisted; backlog
  `store-secondary-index-persistence`). If the differ or `export_schema` needs
  these tags to round-trip, prefer a follow-up backlog ticket over widening this
  one — see the differ TODO below.
- **Differ consistency.** `schema-differ.ts` treats
  `quereus.expose_implicit_index` as compared schema state and consumes
  `collectSchemaCatalog`. Adding synthetic `CatalogIndex` entries in store mode
  makes the catalog match memory's shape (good for cross-backend parity), but
  verify the differ does not now see a spurious add/drop for the synthetic index
  against a declaration. Keep `exposedIndexTags` out of any canonical body
  `definition` (tags already live separate from `definition`), so a tag-only
  change stays an `ALTER INDEX … SET TAGS`, never a drop+recreate.

## TODO

### Phase 1 — schema state + helper
- [ ] Add `exposedIndexTags?: Readonly<Record<string, SqlValue>>` to
      `UniqueConstraintSchema` (`schema/table.ts`) with the doc comment above.
- [ ] Add `exposedImplicitIndexes(tableSchema)` (+ `SyntheticExposedIndex`) to
      `schema/catalog.ts`, reusing the existing name/exposure derivation and the
      memory descriptor shape (per-column collation, predicate, NO unique flag,
      skip names already in `tableSchema.indexes`).

### Phase 2 — read paths
- [ ] `schema()` TVF (`func/builtins/schema.ts`): after the `tableSchema.indexes`
      loop, emit a `type='index'` row per `exposedImplicitIndexes` descriptor.
- [ ] `index_info()` TVF (`func/builtins/schema.ts`): after the
      `table.indexes` loop, emit per-column rows per descriptor (`unique=0`).
- [ ] `collectSchemaCatalog` (`schema/catalog.ts`): push a `CatalogIndex` per
      descriptor; keep `exposedIndexTags` out of the canonical `definition`.

### Phase 3 — write path
- [ ] `updateIndexTags` (`schema/manager.ts`): add the exposed-constraint
      fallback (read/write `uc.exposedIndexTags`, swap table, fire
      `table_modified`). Hidden implicit stays `NOTFOUND`; memory `IndexSchema`
      path stays first/unchanged.

### Phase 4 — validate
- [ ] Store-mode `50-metadata-tags` passes (primary).
- [ ] Memory `50-metadata-tags` still green (parity).
- [ ] `yarn test` green; `yarn test:store` 0 failing (stream output).
- [ ] Verify differ behavior (no spurious add/drop for the synthetic index);
      if tag round-trip / persistence is required, file a follow-up backlog
      ticket rather than expanding scope. Update `quereus-store/README.md` /
      `docs/schema.md` if the store's exposed-implicit-index behavior is
      described anywhere.
