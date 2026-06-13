description: Canonicalize the four SchemaManager module-call frontiers (createIndex, dropIndex, destroy, importTable→connect) so virtual-table modules always receive canonical stored names, and document the contract
difficulty: medium
files:
  - packages/quereus/src/schema/manager.ts                 # the 4 raw frontiers (line refs below)
  - docs/module-authoring.md                                # new contract subsection (under § Schema Changes)
  - docs/schema.md                                          # § Schema Change Events "Naming contract" para (~line 558) — extend to module calls
  - packages/quereus/test/plan/schema-event-name-casing.spec.ts # sibling test pattern to mirror
  - packages/quereus-store/src/common/key-builder.ts        # audited: all physical keys already lowercase — NO change
  - packages/quereus-store/src/common/store-table.ts         # audited: indexStores map (raw-keyed) — NO change needed (see audit)

# Canonicalize module-facing schema/object names at the SchemaManager frontiers

## Decision (already settled — triage 2026-06-12)

**Option 1.** Modules always receive canonical stored names; module authors may
key storage/registries by the call arguments verbatim. This matches the
engine-wide naming contract (`SchemaManager.canonicalSchemaName`, docs/schema.md
§ Schema Change Events): stored `schemaName` is canonical (lowercase), stored
object names carry their declared display casing, and every schema-change
emitter fires the *stored* names — never the raw spelling of the triggering
statement.

This ticket extends that same contract to the **module-call surface**, which the
event pass deliberately left out.

## Audit result — `quereus-store` (the gating question)

The plan-pass audit of the store's key derivation is **complete and the answer
is: no store-side change, no migration, no read-side case-fold fallback.**

- **Every persisted physical key / store name is already case-folded.** All of
  `buildDataStoreName`, `buildIndexStoreName`, `buildStatsKey`, `buildCatalogKey`,
  `buildViewCatalogKey`, `buildMaterializedViewCatalogKey`, and
  `buildCatalogScanBounds` in `key-builder.ts` apply `.toLowerCase()` to the full
  `{schema}.{table}[_idx_{index}]` string. Canonicalizing the *call args* cannot
  change any physical key — `lowercase(canonical) === lowercase(raw)` — so
  **existing persisted stores remain byte-identical and fully readable.** No
  migration is needed.
- **In-module registries are already case-consistent.** `StoreModule.tables` /
  `stores` / `coordinators` are keyed by `` `${schemaName}.${tableName}`.toLowerCase() ``.
- **The one raw-keyed registry self-heals under Option 1.**
  `StoreTable.indexStores` (store-table.ts ~L271/L480) keys by the *raw*
  `indexName`. It is populated by DML index-maintenance under `idx.name` (the
  *stored display casing*) and released by `StoreModule.dropIndex` under the
  engine-supplied arg. Today the engine passes the **raw drop-statement spelling**,
  so a case-divergent `DROP INDEX` can miss the cached handle (a leaked open
  handle — the same neighborhood as the 2026-06-10 lens-rename triage fix; not
  corruption, because `deleteIndexStore` still tears the lowercased physical store
  down). After this ticket passes the **stored index name** to `dropIndex`, both
  sides use the stored display casing and the lookup is consistent. So
  canonicalizing the frontier is exactly what makes the store's verbatim keying
  correct — confirming Option 1 is both necessary and sufficient, with no store
  edit.

## The frontiers to canonicalize (all in `schema/manager.ts`)

The plan pass swept the **entire** module-call surface, not just the three sites
the source ticket named. Result: four raw frontiers remain; everything else
already passes stored names.

| Frontier | Site | Current (raw) | Change to |
| --- | --- | --- | --- |
| `vtabModule.createIndex` | `createIndex`, ~L2333 | `(db, targetSchemaName, tableName, indexSchema)` | `(db, tableSchema.schemaName, tableSchema.name, indexSchema)` |
| `module.dropIndex` | `dropIndex`, ~L2442 | `(db, schemaName, ownerTable.name, indexName)` | `(db, ownerTable.schemaName, ownerTable.name, storedIndexName)` |
| `module.destroy` | `dropTable`, ~L1474 | `(db, aux, moduleName, schemaName, tableName)` | `(db, aux, moduleName, tableSchema.schemaName, tableSchema.name)` |
| `module.connect` | `importTable`, ~L3064 | `(db, aux, moduleName, targetSchemaName, tableName, …)` | `(db, aux, moduleName, tableSchema.schemaName, tableSchema.name, …)` |

Notes that make each change safe:

- **createIndex**: `tableSchema` is the resolved stored schema (looked up at
  ~L2311 and guaranteed non-null — the not-found throw precedes the call).
  `tableSchema.schemaName` is canonical, `tableSchema.name` is the stored display
  casing. `indexSchema.name` is a **new** object's name and is left untouched — it
  *becomes* the stored index name (same as `CREATE TABLE` storing `stmt.table.name`
  as-spelled). Keep `targetSchemaName` / `tableName` for the local log lines and
  the IF-NOT-EXISTS existing-index check (display-only / already case-insensitive).
- **dropIndex**: `ownerTable.name` is already stored. `storedIndexName` already
  exists (~L2455) but is currently computed **after** the module call — **move its
  computation above the `module.dropIndex` call** and pass it in place of the raw
  `indexName`. `ownerTable.schemaName` is canonical.
- **destroy**: in `dropTable`, the locals `schemaName` / `tableName` are the raw
  drop-statement spellings; `tableSchema` is the resolved stored schema (~L1445).
  Pass `tableSchema.schemaName` / `tableSchema.name`. This also makes the store's
  `destroy` fire its `drop` schema-change event under the stored name (it emits
  `objectName: tableName`), bringing it into line with the engine-wide
  "emitters fire stored names" invariant — assert this (see tests).
- **connect (importTable)**: `tableSchema` is built by `buildTableSchemaFromAST`,
  whose `schemaName` is canonical (`canonicalSchemaName`) and `name` is the stored
  display casing. Pass `tableSchema.schemaName` / `tableSchema.name`. The downstream
  `getOrCreateSchema(targetSchemaName)` and the returned display string may be left
  as-is (Schema names are invariantly lowercase), but prefer switching them to the
  canonical values too for local consistency.

**Out of scope — already canonical (do NOT touch):** `module.create` receives the
full canonical `TableSchema` object; the emit-layer frontiers `module.alterTable`,
`module.renameTable`, and the runtime `module.connect` sites
(`runtime/utils.ts`, `emit/scan.ts`, `emit/remote-query.ts`, `emit/analyze.ts`)
already pass `tableSchema.schemaName` / `tableSchema.name`. `renameTable`'s
`newName` and `createIndex`'s index name are *future* stored names (as-spelled),
which is correct and not a contract violation.

## Documentation

- **docs/module-authoring.md** — add a subsection (under `## Schema Changes`, or a
  short new top-level section "## Identifier casing in module-facing calls")
  stating the contract: every module hook (`create`, `connect`, `createIndex`,
  `dropIndex`, `alterTable`, `renameTable`, `destroy`, `getBackingHost`, …)
  receives **canonical stored names** — `schemaName` canonical (lowercase per
  `SchemaManager.canonicalSchemaName`); object names in their stored display
  casing; never the raw triggering-statement spelling. Modules **may** key
  storage and internal registries by the arguments verbatim. Call out the one
  as-spelled exception class: a *new* object's own name (the index name in
  `createIndex`, `newName` in `renameTable`) is the future stored name. Cross-link
  docs/schema.md § Schema Change Events.
- **docs/schema.md** — extend the "Naming contract" paragraph at ~L558 with one
  sentence: the same stored-name guarantee now holds for module-facing calls, not
  only events; link to module-authoring.md. (No claim elsewhere in schema.md
  asserts module args are "as-spelled", so nothing to retract — verified.)

## Edge cases & interactions

- **Mixed-case qualifier, `CREATE INDEX … on T` (stored `t`)** — module must
  receive `t` / `main`, not `T` / `MAIN`. Pin via a recording module.
- **Unqualified DDL under a non-`main` current schema** — module must receive the
  current schema canonicalized (e.g. `aux`), matching `getCurrentSchemaName()`
  resolution. The sibling spec already pins the engine-internal create/drop
  symmetry under `aux`; add the module-arg assertion.
- **`MAIN.`-created table, then unqualified `DROP TABLE`/`DROP INDEX`** — destroy /
  dropIndex must receive the canonical `main`, so a module keying by the arg finds
  the create-time key. This is the create/drop key-symmetry hazard.
- **Case-divergent `DROP INDEX iDx` vs stored `idx`** — `storedIndexName` must
  flow to `module.dropIndex` so the store's `indexStores` handle (cached under the
  stored `idx`) is released, not leaked. Pin that the arg is `idx`.
- **Store round-trip (catalog import → `connect`)** — after a close→reopen, the
  rehydrated `connect` must receive canonical names. Physical keys are unchanged
  (all lowercased), so a pre-existing store opens cleanly; assert no resurrection
  / no orphaned store. Best exercised under `yarn test:store`.
- **IF EXISTS / not-found paths** — `dropIndex` / `dropTable` with `ifExists` and a
  missing object must still short-circuit *before* the module call (unchanged);
  the canonicalization only affects the args on the success path.
- **Non-store modules (memory, isolation wrapper)** — memory module is
  case-insensitive internally, so behavior is unchanged; the recording module is
  the assertion vehicle. The isolation wrapper forwards args verbatim — confirm it
  still resolves its underlying table (it keys by lowercased `{schema}.{table}`).
- **No physical-key drift** — explicitly assert (store test) that a table/index
  created under one casing and dropped/queried under another addresses the same
  store, i.e. the change is observably a *display/registry* fix, not a key change.

## TODO

### Phase 1 — engine canonicalization
- Edit `createIndex` (~L2333): pass `tableSchema.schemaName`, `tableSchema.name`.
- Edit `dropIndex` (~L2442): hoist `storedIndexName` above the module call; pass
  `ownerTable.schemaName`, `ownerTable.name`, `storedIndexName`.
- Edit `dropTable`→`destroy` (~L1474): pass `tableSchema.schemaName`,
  `tableSchema.name`.
- Edit `importTable`→`connect` (~L3064): pass `tableSchema.schemaName`,
  `tableSchema.name` (and optionally the canonical values to `getOrCreateSchema`
  and the returned name string).
- Update the inline comments at each site to reference the
  `canonicalSchemaName`/stored-name invariant (mirror the existing event-emitter
  comments already in this file).

### Phase 2 — tests
- New spec `packages/quereus/test/schema/module-name-canonicalization.spec.ts`:
  register a minimal recording `VirtualTableModule` (model on
  `test/vtab/test-query-module.ts`) that captures the `schemaName` / `tableName` /
  `indexName` args handed to `create`, `connect`, `createIndex`, `dropIndex`, and
  `destroy`. Drive mixed-case + unqualified DDL (`create table MAIN.T`,
  `create index IDX on t`, `drop index iDx`, `drop table T`, non-`main` current
  schema) and assert each captured arg is the **canonical stored name**
  (`main` / stored display casing), never the raw spelling.
- Extend `test/plan/schema-event-name-casing.spec.ts` only if a cached-plan
  assertion naturally fits; the dedicated recording-module spec is the primary
  coverage.
- Store round-trip: add/adjust a store logic or unit test (runs under
  `yarn test:store`) asserting a case-divergent create/drop addresses one physical
  store and reopen does not resurrect/orphan. If a focused store unit test is
  cheaper than a full `test:store` cycle, prefer it.

### Phase 3 — docs
- Add the module-authoring.md contract subsection.
- Extend the schema.md § Schema Change Events naming-contract paragraph.

### Validation
- `yarn workspace @quereus/quereus test` (fast, memory-backed) must stay green,
  including the new spec.
- `yarn lint` in `packages/quereus` (eslint + test-file typecheck) for the new
  spec's call-site types.
- `yarn test:store` for the store round-trip assertion (store-specific; stream
  output with `tee` per AGENTS.md). If the full store cycle is too slow for one
  agent run, document the deferral and let CI carry it.
