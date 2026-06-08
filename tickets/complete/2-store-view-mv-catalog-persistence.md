description: Persist views & materialized views in the store `__catalog__` (reserved-prefix keys), subscribe the SchemaChangeNotifier listener to view/MV lifecycle + tag events, and phase rehydration tables → views → MVs (MVs re-materialized via `db.exec`, dependency-ordered by fixpoint retry). Brings CREATE/DROP VIEW, CREATE/DROP MATERIALIZED VIEW, and ALTER VIEW|MATERIALIZED VIEW … SET/ADD/DROP TAGS to durable parity with tables. Reviewed and completed.
files:
  - packages/quereus-store/src/common/key-builder.ts
  - packages/quereus-store/src/common/store-module.ts
  - packages/quereus-store/src/common/index.ts
  - packages/quereus-store/test/view-mv-persistence.spec.ts
  - docs/schema.md
  - packages/quereus-store/README.md
----

# Persist views and materialized views for store-backed databases (reviewed)

## What landed

The generic store module persists **views** and **materialized views** in
`__catalog__` and rehydrates them on reopen, reaching durable parity with tables
for `CREATE/DROP VIEW`, `CREATE/DROP MATERIALIZED VIEW`, and `ALTER VIEW|MATERIALIZED
VIEW … {SET|ADD|DROP} TAGS`. Store-package only; rides the already-landed engine
support (`view_*`/`materialized_view_*` events + `generateViewDDL` /
`generateMaterializedViewDDL` + silent `importCatalog` view registration).

- **Key namespaces** — tables keep their unprefixed `{schema}.{table}` key; views
  get `\x00view\x00{schema}.{view}` and MVs `\x00mview\x00{schema}.{mv}`. A leading
  `0x00` can't appear in a table identifier key, so the three namespaces are
  disjoint. `classifyCatalogKey` routes a loaded entry; `decodeMaterializedViewCatalogKey`
  recovers the MV name for the result.
- **Incremental persistence** — `onEngineSchemaChange` is a switch over the event
  union; view/MV add/modify/refresh compare-write the regenerated DDL (skip
  identical), remove deletes. All writes serialize on `persistQueue` via
  `enqueuePersist`, drained by `closeAll`/`whenCatalogPersisted`. No catalog-absent
  self-filter for view/MV (one module ⇒ one Database). The MV memory backing's
  `table_*` events stay ignored, so the backing is never persisted.
- **Subscription up front** — `rehydrateCatalog` now calls `ensureSchemaSubscription`
  so a reopened DB persists subsequent view/MV DDL even when its first post-reopen
  statement is a view/MV (which never hits a module hook).
- **Rehydration phasing** — load + classify once, then import tables → views
  (silent register, order-independent) → MVs (re-materialized via `db.exec`,
  dependency-ordered by a fixpoint retry). Per-entry errors are non-fatal and land in
  `RehydrationResult.errors`; the result gains additive `views`/`materializedViews`.

## Review findings

Adversarial pass over commit `669c61b3`. Read the full implement diff (key-builder,
store-module, tests, both docs) with fresh eyes before the handoff, then cross-checked
every engine assumption the store relies on.

### Checked and verified correct (no change)
- **Engine event contracts** — `view_added/_modified/_removed`,
  `materialized_view_added/_modified/_refreshed/_removed` shapes match the handler:
  `_modified`/`_added` carry `newObject`, `_refreshed` carries `object` (the handler
  correctly reads `event.object` there), `_removed` carries `schemaName`/`objectName`.
  Confirmed in `schema/change-events.ts` and the emitters (`create-view.ts`,
  `drop-view.ts`, `materialized-view.ts`, `manager.ts` tag setters).
- **DDL generators** — `generateViewDDL` / `generateMaterializedViewDDL` lift the live
  schema (current tags) via the shared AST-stringify path (drift-free, fully qualified,
  MV drops the informational `using`). The engine spec `view-mv-ddl-persistence.spec.ts`
  pins the parse→generate→parse fixed point.
- **`importCatalog`** — silently registers a view (no event, deferred body validation,
  names it in `.views`) and fails loud on an MV — so the phase split (views via
  `importCatalog`, MVs via `db.exec`) is the correct division.
- **Fixpoint retry** — re-derived the loop by hand for mixed success/failure and
  multi-round cases: it converges, records only genuine failures (the `!progressed`
  round), and never loses an entry. A real MV-over-MV *cycle* cannot exist in the
  catalog (create-time requires the dependency to exist), so the "cycle" branch is
  defensive, not a live path.
- **Subscription lifetime / cleanup** — `ensureSchemaSubscription` is idempotent and
  single-DB; `closeAll` unsubscribes the listener *before* draining `persistQueue`, so
  no write is enqueued mid-close. Verified against the existing tag-persistence
  "listener detached after closeAll" test.
- **Idempotency** — phase-3 MV re-exec re-fires `materialized_view_added` → compare-skip,
  so a second reopen yields byte-identical catalog bytes (tested). A failed MV `db.exec`
  is cleaned up by the create emitter's catch (drops backing + unregisters), leaving no
  partial state for the retry — confirmed via the dependent-first fixpoint test.
- **`loadAllDDL` widening** — now returns view/MV values intermixed; its only remaining
  callers are tests that create tables only (`alter-table.spec.ts`), so unaffected.
- **Docs** — read every touched doc against the new reality. The `docs/schema.md`
  "View and materialized-view persistence" subsection and README key-namespace/phasing
  notes are accurate; cross-doc anchors (`#view-and-materialized-view-persistence`,
  `#store-catalog-persistence-bundled-index-ddl`) resolve.

### Minor — fixed inline this pass
- **Test coverage (riskiest path).** The implementer flagged that a 3+-deep MV chain
  (multi-round fixpoint) was not explicitly exercised — only a 2-MV dependent-first
  case. Added `a 3-deep MV chain rehydrates through multiple fixpoint rounds`: names
  the chain so each level sorts *before* its source (forcing three rounds), asserts a
  clean rehydrate, correct rows, and that row-time maintenance survives up the whole
  rehydrated chain. Store suite: **346 → 347 passing**.
- **Stale doc cross-reference.** This commit's docs (`docs/schema.md`,
  `packages/quereus-store/README.md`) pointed the "exposed implicit index user tags"
  gap at backlog `store-secondary-index-persistence` — but that ticket is in
  `complete/` and (by the doc's own framing) never covered `exposedIndexTags`, which is
  separate from the bundled index DDL. Filed `backlog/store-exposed-implicit-index-tags-persistence.md`
  for the genuine, previously-untracked gap and repointed both docs to it.

### Major — none
No correctness, resource-cleanup, type-safety, or error-handling defects found that
warranted a new fix/plan ticket. The one new backlog ticket is for a pre-existing,
tangential index-tag gap surfaced by a stale reference, not a defect in this work.

### Accepted gaps (documented by the implementer; confirmed real, not findings)
- **First-DDL-is-view on a never-rehydrated, brand-new DB** isn't persisted (no prior
  table hook established the subscription). Reopened DBs and DBs that create a store
  table first are unaffected. Documented in code + docs.
- **MV over a memory (non-persisted) source** re-materializes against an absent source
  on reopen → recorded in `errors`, MV not registered. Inherent to mixing memory
  sources into a durable catalog. Tested.
- **Inherited engine gap** `backlog/view-body-rewrite-fires-no-schema-event` — an
  `ALTER TABLE … RENAME` that rewrites a dependent view body in place fires no event,
  so a reopen rehydrates a stale view body. Out of scope (engine fix), tracked.

### Coverage floor (considered, deliberately not added)
- **LevelDB / IndexedDB reopen** of a view/MV entry not run end-to-end; the catalog
  write path is provider-agnostic (same `getCatalogStore()` the table catalog already
  exercises on LevelDB). Belt-and-suspenders only — left to a release-prep spot check,
  consistent with the sibling index/tag tickets.
- **MV-over-view** rehydrate not added — MV-over-view eligibility is uncertain enough
  that a test risks failing for unrelated reasons; the view→MV phase ordering already
  guarantees the registration order it would need.

## Validation performed (review pass)
- `yarn workspace @quereus/quereus build` + `yarn workspace @quereus/store build` — clean.
- `yarn workspace @quereus/store test` — **347 passing** (16 original + 1 added; no
  regressions). The error-path console output (`THIS IS NOT VALID SQL`, MV-over-memory)
  is from intentional negative tests.
- `yarn workspace @quereus/quereus lint` — clean (exit 0).
- Backlog/complete ticket cross-references verified on disk.

## End
