description: Exposed implicit covering index (quereus.expose_implicit_index) is not addressable or introspectable in store mode — ALTER INDEX ... TAGS throws NOTFOUND and schema()/index_info never surface it
files:
  - packages/quereus/test/logic/50-metadata-tags.sqllogic (Phase 38, lines ~1059-1080 — the failing case)
  - packages/quereus/src/schema/manager.ts (updateIndexTags ~1017-1050; iterates tableSchema.indexes)
  - packages/quereus/src/schema/catalog.ts (collectSchemaCatalog ~129-169; implicitCoveringIndexExposure ~289-298; isHiddenImplicitIndex ~310)
  - packages/quereus/src/vtab/memory/layer/manager.ts (ensureUniqueConstraintIndexes ~197-220 — memory synthesizes the index entry)
  - packages/quereus-store/src/common/store-module.ts (buildCatalogEntry ~1473; connect/import path — store synthesizes no implicit covering index entry)
  - packages/quereus/src/schema/manager.ts (buildTableSchemaFromAST ~1488; extractUniqueConstraints — populates uniqueConstraints, not indexes)
----

## Summary

The "exposed implicit covering index" feature — a declared/inline UNIQUE
constraint that opts its auto-built enforcement BTree into catalog visibility
via the reserved tag `quereus.expose_implicit_index = true`, making it
user-addressable as an index — works in **memory mode only**. In **store
mode** the exposed index is neither addressable (`ALTER INDEX … {SET|ADD|DROP}
TAGS` throws `NOTFOUND`) nor introspectable (`schema()` / `index_info()` never
surface it).

This is the single failing case in `yarn test:store` (memory `yarn test` is
fully green). The failure is pre-existing at HEAD (`04f3af94`), independent of
the ticket that flagged it (store SET COLLATE / UNIQUE re-validation).

## Failing test

- File: `packages/quereus/test/logic/50-metadata-tags.sqllogic`, **Phase 38**
  ("exposed implicit covering index becomes addressable for ADD / DROP").
- Command (from `packages/quereus`): `node test-runner.mjs --store --grep "50-metadata-tags"`
  (i.e. `yarn test:store`, `QUEREUS_TEST_STORE=1`).

The offending statements:

```sql
create table ExpoTbl (
    id integer primary key,
    vin text,
    constraint uq_expo_vin unique (vin) with tags ("quereus.expose_implicit_index" = true)
);

-- expected to merge onto the (exposed) implicit index's tags:
alter index uq_expo_vin add tags (purpose = 'lookup');
select json_extract(tags, '$.purpose') as purpose
    from schema() where type = 'index' and name = 'uq_expo_vin';
-- → [{"purpose":"lookup"}]
```

## Error output

```
QuereusError: Index 'uq_expo_vin' not found in schema 'main'
  at SchemaManager.updateIndexTags (packages/quereus/src/schema/manager.ts:1032)
  at SchemaManager.mergeIndexTags (packages/quereus/src/schema/manager.ts:1070)
  at Object.run (packages/quereus/src/runtime/emit/set-object-tags.ts:43)
```

Full store suite (`--no-bail`): 5184 passing, 14 pending, 1 failing — only this.
(Report cited manager.ts:940/976; the current HEAD lines are 1032/1070 — the
file shifted, same code path.)

## Root cause

The whole feature is built around the implicit covering index existing as a
concrete `IndexSchema` entry in `tableSchema.indexes`:

- **Read path** — `catalog.ts` `collectSchemaCatalog` (~lines 129-169) iterates
  `tableSchema.indexes`, consulting `implicitCoveringIndexExposure(tableSchema)`
  to decide visibility. An index absent from `tableSchema.indexes` can never be
  surfaced, regardless of the exposure tag on the constraint.
- **Write path** — `SchemaManager.updateIndexTags` (~lines 1017-1050) resolves
  the owning table by scanning `tableSchema.indexes` for a name match; not found
  ⇒ `NOTFOUND`. Tags are stored *on the `IndexSchema`*, so there is nowhere to
  put them when no such entry exists.

**Memory mode** synthesizes that entry: `MemoryTableLayerManager.ensureUnique`-
`ConstraintIndexes` (`vtab/memory/layer/manager.ts:197`) appends an `IndexSchema`
named `uc.name ?? '_uc_<cols>'` to `tableSchema.indexes` for every UNIQUE
constraint (the covering BTree is the enforcement mechanism). So in memory mode
`uq_expo_vin` is a real (hidden-by-default) index entry; the exposure tag flips
it visible and addressable.

**Store mode** synthesizes none. `SchemaManager.buildTableSchemaFromAST`
(`manager.ts:1488`) populates `tableSchema.uniqueConstraints` (via
`extractUniqueConstraints`) but never appends implicit covering indexes — the
store enforces UNIQUE by full-scan over `uniqueConstraints` at write time, and
reserves `tableSchema.indexes` for *real persistent* secondary index stores.
So in store mode `uq_expo_vin` exists only as a `UniqueConstraintSchema`, never
as an `IndexSchema`, and both paths above miss it.

## Why this is not a tightly-scoped fix (design needed)

The naïve "just synthesize the index entry in store mode too" is unsafe:

- `buildCatalogEntry` (`store-module.ts:1473`) emits a `CREATE INDEX` line for
  every non-hidden entry in `tableSchema.indexes`. An *exposed* implicit index is
  not hidden (`isHiddenImplicitIndex` returns false for it), so a synthesized
  entry would be **persisted as a real `CREATE INDEX`** and, on reopen, rehydrate
  into a genuine secondary index store — double-maintenance against the
  full-scan UNIQUE enforcement the store actually uses. The hidden case is
  excluded today precisely because store builds no such entries.
- The alternative — keep the index out of `tableSchema.indexes` and instead
  route the exposed-implicit case through `uniqueConstraints` in *both*
  `catalog.ts` and `updateIndexTags`, storing the tags on the
  `UniqueConstraintSchema` — is a real data-model change (where do an exposed
  implicit index's tags live?) touching the catalog surface, the ALTER INDEX
  write path, and the tag read paths, and must stay consistent with the
  declarative differ (`schema-differ.ts` treats `quereus.expose_implicit_index`
  as compared schema state).

Either direction is a cross-subsystem design decision (memory/store schema
parity vs. persistence safety), not a local patch — hence backlog rather than an
inline triage fix.

## Ruled out

- **Not caused by the flagging ticket** (store SET COLLATE / existing-row UNIQUE
  re-validation): that diff touches `validateUniqueOverExistingRows` /
  `buildIndexEntries` / the `ALTER COLUMN … SET COLLATE` arm — none on the
  index-tag path. Reproduces at HEAD (`04f3af94`) with a clean tree.
- **Not a generic ALTER INDEX … TAGS regression**: ordinary `CREATE INDEX`
  indexes and hidden/exposed cases all pass in memory mode; the store suite is
  otherwise green. The break is specific to the *implicit covering index of a
  UNIQUE constraint* in store mode, which is never materialized into
  `tableSchema.indexes`.
- **Not solely a write-path (`updateIndexTags`) bug**: the read path
  (`schema()` / `index_info()` via `collectSchemaCatalog`) iterates the same
  `tableSchema.indexes` and would also fail to surface the exposed index in store
  mode, so fixing only `updateIndexTags` would still leave the subsequent
  `select … from schema()` assertion (and Phase 38's DROP round-trip) failing.

## Possible directions (for the plan stage to resolve)

- **A — route exposed-implicit through `uniqueConstraints` in both paths.** Make
  `catalog.ts` derive a synthetic catalog index from each exposed
  `UniqueConstraintSchema` (independent of `tableSchema.indexes`), and make
  `updateIndexTags` read/write the tags on the `UniqueConstraintSchema` when no
  `IndexSchema` matches but an exposed constraint does. Engine-wide; works for
  both backends; needs a decided home for the tags and differ consistency.
- **B — store synthesizes a non-persistable implicit index entry.** Add the
  `IndexSchema` to `tableSchema.indexes` in the store connect/import path but
  mark it so `buildCatalogEntry` (and any real index-store creation/maintenance)
  skips it. Smaller surface but introduces a "phantom index" concept the store
  must honor everywhere it walks `tableSchema.indexes`.
- Decide whether store mode should support `expose_implicit_index` at all, or
  whether Phase 38 should be gated to memory mode pending the above — the test
  currently asserts cross-backend parity.
