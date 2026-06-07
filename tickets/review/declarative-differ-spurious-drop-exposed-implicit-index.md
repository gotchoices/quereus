description: Review the fix for the spurious `DROP INDEX IF EXISTS <name>` the declarative differ emitted for an exposed implicit covering index (a UNIQUE constraint tagged `quereus.expose_implicit_index`). The catalog now marks such entries `CatalogIndex.implicit = true`; the differ filters them out of its standalone-index buckets so a converged schema diffs empty across both backends.
files:
  - packages/quereus/src/schema/catalog.ts (CatalogIndex.implicit marker; collectSchemaCatalog memory loop ~163 + store synthetic loop ~175; indexSchemaToCatalog ~421)
  - packages/quereus/src/schema/schema-differ.ts (computeSchemaDiff — actualIndexes filter ~291)
  - packages/quereus/test/covering-structure.spec.ts (introspection-hiding assertion + new `declarative idempotency — exposed implicit covering index` describe)
  - packages/quereus/test/logic/50-declarative-schema.sqllogic (new exposed-implicit-index phase at EOF; runs both backends via test:store)
  - docs/schema.md (index body-change detection section, ~line 442)
----

## What was wrong

An exposed implicit covering index (the secondary BTree backing a UNIQUE
constraint tagged `quereus.expose_implicit_index = true`) is surfaced by
`collectSchemaCatalog` as a `CatalogIndex` so introspection (`schema()`,
`index_info()`) can see it. Its lifecycle, however, belongs to the originating
UNIQUE *constraint* (matched no-churn via the named-constraint path), not to
`CREATE/DROP INDEX`. The differ double-counted the object: matched as a
constraint, **and** — because it also appeared in `actualCatalog.indexes` with no
matching `declare … index` — scheduled for a phantom `DROP INDEX IF EXISTS
<name>` by the orphan-drop loop. A converged schema produced a migration instead
of a no-op, violating the declarative idempotency contract.

## The fix (small, single chokepoint)

- **`CatalogIndex.implicit?: boolean`** marker added (catalog.ts). Set at the two
  (and only two) surfacing sites: the memory real-index loop marks `true` exactly
  when `exposed === true` (ordinary indexes stay unmarked); the store synthetic
  loop (`exposedImplicitIndexes`) marks every descriptor. Threaded through
  `indexSchemaToCatalog(..., implicit = false)`, which sets the field **only when
  true** — so an ordinary index's catalog shape is byte-identical to before (no
  `implicit: false` noise; relevant because some tests `.find`/`.map` over
  `catalog.indexes`).
- **Differ filter** (schema-differ.ts:291): `actualIndexes` is built from
  `actualCatalog.indexes.filter(i => !i.implicit)`. This single map feeds all
  three downstream index consumers — rename resolution (`resolveRenames`), the
  create/body loop, and the orphan-drop loop — so a marked entry can never enter
  `indexesToCreate`, `indexesToDrop`, `indexTagsChanges`, or a rename op.
  Confirmed by grep: `actualCatalog.indexes` has no other consumer in the differ.

## How to validate

- **Reproduction now no-ops.** Memory: `declare schema main { table ExpoTbl { id
  INTEGER PRIMARY KEY, vin TEXT, constraint uq_expo_vin unique (vin) with tags
  ("quereus.expose_implicit_index" = true) } }` → `apply schema main` →
  `computeSchemaDiff(declared, collectSchemaCatalog(db))` yields
  `indexesToCreate == []`, `indexesToDrop == []`, and
  `generateMigrationDDL(diff,'main') == []`. (Pre-fix this emitted
  `DROP INDEX IF EXISTS uq_expo_vin`.)
- **Tests added (the floor, not the ceiling):**
  - `covering-structure.spec.ts` → `declarative idempotency — exposed implicit
    covering index`: asserts empty index buckets + empty migration DDL under
    **both** `allow` and `require-hint`, and that the index is still surfaced AND
    carries `implicit === true`. The existing `introspection hiding` test was
    extended to assert the marker.
  - `50-declarative-schema.sqllogic` EOF phase: declare exposed-UNIQUE table →
    apply → `diff schema decl_expo_idx;` → `[]`; also asserts UNIQUE enforcement
    still rejects a duplicate (the constraint, not the index, governs it). Runs
    memory (`yarn test`) **and** store (`yarn test:store`) — both pass.
- **Full suites green:** `yarn build` (0), `yarn test` (memory, 5199 passing in
  quereus + all other packages), `yarn test:store` (5194 passing), and
  `eslint` on `packages/quereus` (0).

## Points a reviewer should scrutinize (honest gaps / things to double-check)

- **`require-hint` is asserted EMPTY, not throwing.** Per the source ticket's
  empirical findings, the spurious entry was a *pure drop* (1 drop / 0 creates),
  and `enforceRequireHint` only throws when creates>0 AND drops>0. So pre-fix
  `require-hint` *silently executed* the drop rather than erroring. The test
  asserts the diff is empty (neither silent-drop nor a create+drop hard-error can
  arise). It does **not** exercise the create+drop-coincidence shape (an exposed
  implicit index alongside an unrelated index create) — a reviewer wanting belt-
  and-suspenders could add that case, though the filter makes it moot by
  construction.
- **Marker is set only at the two `collectSchemaCatalog` sites.** If a future code
  path constructs a `CatalogIndex` for an exposed implicit structure elsewhere, it
  would need to set `implicit` too. Today `indexSchemaToCatalog` is the sole
  producer and has exactly two call sites (verified).
- **Collision safety is graceful-degrade, not prevented.** A user `declare … index`
  whose name collides with an exposed constraint's implicit name is impossible by
  construction today, but if it ever arose, the filter makes the marked actual
  invisible to declared-index matching → the declared index is *created* (rather
  than a spurious drop of the constraint's structure). Acceptable, but a reviewer
  may want a guard or an explicit assertion documenting this.
- **Real `CREATE UNIQUE INDEX` is unaffected.** UNIQUE constraints with
  `derivedFromIndex` are excluded from the exposure map, so a genuine unique index
  stays differ-managed (the `decl_uniq` sqllogic phase still round-trips empty).
  Worth a sanity glance that the marker didn't leak onto those.
- **No new atomicity / enforcement behavior.** The fix is catalog-marker +
  differ-filter only; UNIQUE enforcement (routed through `uniqueConstraints`) and
  the `ALTER INDEX … SET TAGS`→constraint routing
  (`findExposedImplicitConstraintIndex`/`updateIndexTags`) are untouched. The
  sqllogic phase confirms enforcement still fires.

## Docs

`docs/schema.md` § "Index body-change detection" updated: the prior sentence
claimed implicit covering indexes are simply absent from `actualCatalog.indexes`;
it now distinguishes **hidden** (absent → never name-matches) from **exposed**
(present for introspection, marked `CatalogIndex.implicit`, filtered out of
`actualIndexes`), and states the convergence/no-phantom-drop guarantee.
