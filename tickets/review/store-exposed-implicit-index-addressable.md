description: Review the store-mode fix that makes an exposed implicit covering index (quereus.expose_implicit_index) addressable + introspectable by deriving a synthetic index from uniqueConstraints in the read paths and routing ALTER INDEX … TAGS onto a new UniqueConstraintSchema.exposedIndexTags field — without materializing a phantom index in the store.
files:
  - packages/quereus/src/schema/table.ts (UniqueConstraintSchema.exposedIndexTags — new field)
  - packages/quereus/src/schema/catalog.ts (implicitIndexName, SyntheticExposedIndex, exposedImplicitIndexes, findExposedImplicitConstraintIndex; collectSchemaCatalog synthetic loop)
  - packages/quereus/src/func/builtins/schema.ts (buildIndexCreateSql helper; schema() + index_info() TVF synthetic loops)
  - packages/quereus/src/schema/manager.ts (updateIndexTags — exposed-constraint fallback)
  - packages/quereus/test/logic/50-metadata-tags.sqllogic (Phase 38 — was the only failing store case)
  - docs/schema.md (Introspection note — cross-backend addressability + known persistence gap)
----

## What shipped

Direction A from the implement ticket: for backends that do **not** materialize a
UNIQUE constraint's implicit covering index (the store enforces UNIQUE by
full-scan over `uniqueConstraints`), the engine now *derives* a synthetic exposed
index from each exposed `UniqueConstraintSchema` in the read paths, and routes its
tags onto the constraint in the write path. Memory mode is untouched — it keeps
materializing the index as an `IndexSchema` and surfacing it via the existing
`tableSchema.indexes` loops.

The store's physical model is unchanged: no implicit-index KV store is created,
DML still enforces UNIQUE via full-scan, and the planner is never offered a
non-existent index. (Direction B — materialize a phantom `IndexSchema` in the
store — was rejected; rationale captured in the original implement ticket / git
history.)

### Changes

- **Schema state** (`table.ts`): added `UniqueConstraintSchema.exposedIndexTags`
  — user-addressable tags for the exposed implicit index, kept SEPARATE from
  `uc.tags` (which holds the `quereus.expose_implicit_index` flag), so the
  exposure flag never leaks into surfaced index tags.
- **Helpers** (`catalog.ts`):
  - `implicitIndexName(tableSchema, uc)` — single source of the deterministic
    name `uc.name ?? '_uc_<cols>'` (matches `ensureUniqueConstraintIndexes`),
    now reused by `implicitCoveringIndexExposure`.
  - `SyntheticExposedIndex` + `exposedImplicitIndexes(tableSchema)` — returns
    descriptors for exposed constraints whose implicit name is NOT already in
    `tableSchema.indexes`. Returns `[]` in memory mode (already materialized), so
    read-path callers append unconditionally with no double-listing. Descriptor
    deliberately carries NO `unique` flag (mirrors the memory materialized entry).
  - `findExposedImplicitConstraintIndex(tableSchema, indexName)` — write-path
    counterpart; returns the constraint index or `-1`. Returns `-1` for
    hidden/materialized implicit indexes (preserving their `NOTFOUND`).
- **Read paths** — after iterating the real `tableSchema.indexes`, each site now
  also iterates `exposedImplicitIndexes`:
  - `collectSchemaCatalog` (catalog.ts) — pushes a `CatalogIndex` per descriptor
    (reuses `indexSchemaToCatalog`; `SyntheticExposedIndex` is structurally an
    `IndexSchema`). Tags stay out of the canonical `definition`.
  - `schema()` TVF (schema.ts) — yields a `type='index'` row per descriptor.
    Inline `CREATE INDEX …` build was extracted to `buildIndexCreateSql` and
    shared by both the real and synthetic loops.
  - `index_info()` TVF (schema.ts) — yields per-column rows per descriptor;
    `unique=0` (synthetic has no unique flag), `partial = predicate ? 1 : 0`.
- **Write path** — `updateIndexTags` (manager.ts) now has two phases: (1) the
  existing materialized-`IndexSchema` path (memory; runs first, unchanged
  semantics, now via the shared `commitTagUpdate` helper); (2) a fallback that
  finds the exposed constraint via `findExposedImplicitConstraintIndex` and
  read-modify-writes `uc.exposedIndexTags` (drop the field when it collapses to
  empty). `NOTFOUND` only when neither matches. Same `TagCompute` contract, so
  SET/ADD/DROP semantics are identical.
- **Docs** (`docs/schema.md`) — Introspection note updated: exposed implicit
  index is addressable/introspectable identically across backends; tags live on
  `IndexSchema.tags` (memory) vs `UniqueConstraintSchema.exposedIndexTags`
  (store); hidden implicit stays `NOTFOUND`; persistence gap called out.

## Use cases / behavior to validate

Primary scenario (`50-metadata-tags.sqllogic` Phase 38), now passing in BOTH
modes:

```sql
CREATE TABLE ExpoTbl (
    id INTEGER PRIMARY KEY,
    vin TEXT,
    CONSTRAINT uq_expo_vin UNIQUE (vin) WITH TAGS ("quereus.expose_implicit_index" = true)
);
ALTER INDEX uq_expo_vin ADD TAGS (purpose = 'lookup');   -- merges onto exposedIndexTags
SELECT json_extract(tags,'$.purpose') FROM schema() WHERE type='index' AND name='uq_expo_vin';  -- 'lookup'
ALTER INDEX uq_expo_vin DROP TAGS (purpose);             -- index stays addressable (visibility is on the constraint)
```

Parity invariants that must hold (all currently green):
- Phase 22: hidden implicit `SET TAGS` → NOTFOUND (both modes).
- Phase 37: hidden implicit `ADD`/`DROP TAGS` → NOTFOUND (both modes).
- Phase 38: exposed implicit `ADD`/`DROP TAGS` → addressable (both modes).
- `schema()` / `index_info()` rows for `uq_expo_vin` match between memory and
  store (same name, columns, `unique=0`).

## Validation performed

- `yarn build` (tsc) — clean. `tsc --noEmit` — clean. `yarn lint` — clean.
- `node test-runner.mjs --store --grep "50-metadata-tags"` — passing (the
  primary repro; previously `QuereusError: Index 'uq_expo_vin' not found`).
- `node test-runner.mjs --grep "50-metadata-tags"` (memory) — passing.
- `node test-runner.mjs` (memory full) — **5197 passing / 9 pending / 0 failing**.
- `node test-runner.mjs --store` (store full) — **5192 passing / 14 pending /
  0 failing** (was 5184/14/**1** at the flagging SHA; target met).
- Spec tests referencing the feature — `covering-structure.spec.ts`,
  `schema-manager.spec.ts`, `schema/reserved-tags.spec.ts` (222 passing) and
  `schema-differ.spec.ts` + `differ-alter-column.spec.ts` (25 passing).

## Known gaps / reviewer focus (treat tests as a floor)

- **Tag persistence across store reopen is OUT OF SCOPE and a known gap.**
  Because `exposedIndexTags` is a separate field, the table DDL's `WITH TAGS`
  emits only `uc.tags` (the exposure flag), so an exposed index's *user* tags do
  not survive a store close→reopen. Phase 38 does not reopen, so this does not
  block the fix. Tracked under backlog `store-secondary-index-persistence`. If
  the reviewer judges round-trip is required, prefer a follow-up ticket over
  widening this one. **No store-reopen test exists for exposed-index tags** —
  this is the most likely place a reviewer-added test would surface something.
- **Differ behavior** — verified specs pass and the store full suite (which
  exercises declarative paths) is green, so synthetic `CatalogIndex` entries do
  not produce a spurious add/drop. But there is no *dedicated* test asserting
  "declare a table with an exposed UNIQUE constraint, diff against the live store
  catalog → empty diff". Worth an adversarial check: confirm both the desired and
  current catalogs route through `collectSchemaCatalog` (so both carry the
  synthetic index and cancel), and that a tag-only change yields `ALTER INDEX …
  SET TAGS` rather than drop+recreate (`exposedIndexTags` is kept out of the
  canonical `definition`).
- **Structural typing reliance** — `SyntheticExposedIndex` is passed where
  `IndexSchema` is expected (in `indexSchemaToCatalog`) and the `index_info()`
  loop spreads `[...realIndexes, ...synthetic]` and uses `'unique' in idx` to
  narrow. tsc accepts it; a reviewer may prefer an explicit shared type or a
  discriminated handling — judgment call, not a correctness issue.
- **Other readers of `tableSchema.indexes`** — only the three read paths named in
  the ticket were wired. If any other introspection surface enumerates indexes
  and should now show the exposed implicit index in store mode, it was not in
  scope; worth a quick grep sanity check (`find_references tableSchema.indexes` /
  `table.indexes`).

## Suggested commit message

`task(implement): store-exposed-implicit-index-addressable`
