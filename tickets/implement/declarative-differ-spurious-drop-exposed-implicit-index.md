description: The declarative schema differ emits a spurious `DROP INDEX IF EXISTS <name>` for an exposed implicit covering index (a UNIQUE constraint tagged quereus.expose_implicit_index). Mark such indexes in the catalog and exclude them from the differ's standalone-index create/drop/rename buckets so a converged schema diffs empty across both backends.
prereq:
files:
  - packages/quereus/src/schema/catalog.ts (CatalogIndex interface; collectSchemaCatalog memory + store surfacing loops; indexSchemaToCatalog)
  - packages/quereus/src/schema/schema-differ.ts (computeSchemaDiff — actualIndexes map ~line 281; index rename resolution ~312-322; orphan-drop loop ~466-469)
  - packages/quereus/test/covering-structure.spec.ts (introspection-hiding describe block — natural home for the idempotency regression test)
  - packages/quereus/test/logic/50-declarative-schema.sqllogic (sqllogic phase — runs both memory & store via test:store)
----

## Summary

An exposed implicit covering index (the secondary BTree backing a UNIQUE
constraint tagged `quereus.expose_implicit_index = true`) is surfaced by
`collectSchemaCatalog` as a `CatalogIndex` so introspection (`schema()`,
`index_info()`) can see it. But its lifecycle is governed by the originating
UNIQUE *constraint*, not by `CREATE/DROP INDEX`. The differ doesn't know this:
the constraint is matched (no churn) via the named-constraint path, while the
*same object* also appears in `actualCatalog.indexes` with no matching
`declare … index` entry — so the orphan-drop loop schedules a phantom
`DROP INDEX IF EXISTS <name>`. The object is double-counted: matched as a
constraint, dropped as a standalone index.

Fix: mark the exposed-implicit `CatalogIndex` entries, and have the differ
exclude marked entries from all standalone-index buckets (rename / create /
drop). Introspection consumers keep seeing them; the differ ignores them.

## Reproduction (confirmed, memory mode)

```sql
declare schema main {
    table ExpoTbl {
        id INTEGER PRIMARY KEY,
        vin TEXT,
        constraint uq_expo_vin unique (vin) with tags ("quereus.expose_implicit_index" = true)
    }
}
apply schema main;
-- collectSchemaCatalog + computeSchemaDiff now yields:
--   ACTUAL INDEXES: [ 'uq_expo_vin' ]
--   indexesToDrop:   [ 'uq_expo_vin' ]
--   MIGRATION DDL:   [ 'DROP INDEX IF EXISTS uq_expo_vin' ]
```

So a converged schema produces a migration instead of a no-op — the declarative
contract violation.

## Findings that refine the source ticket (read before implementing)

These were verified empirically against `d6585fd8`/this branch (memory mode);
do NOT over-fit the fix to the source ticket's stated symptoms where they
diverge:

- **require-hint does NOT hard-error for this minimal case.** `enforceRequireHint`
  throws only when *both* `creates > 0 AND drops > 0` (the ambiguous
  unhinted-rename shape; `schema-differ.ts:671-678`). The spurious entry is a
  *pure drop* (1 drop, 0 creates), so `apply schema main options (rename_policy =
  'require-hint')` currently *succeeds* and silently executes the drop. The
  require-hint hard-error only manifests if the same diff *also* carries an index
  create (e.g. an unrelated index rename in the same apply). The acceptance test
  must still cover require-hint, but assert the diff is **empty** (so neither the
  silent-drop nor the create+drop hard-error can ever arise), not that
  require-hint throws in the minimal case.

- **Memory-mode UNIQUE enforcement is NOT actually weakened by the drop.** After
  a re-apply executes `DROP INDEX IF EXISTS uq_expo_vin`, a duplicate insert still
  fails (`UNIQUE constraint failed: ExpoTbl (vin)`): UNIQUE enforcement routes
  through `uniqueConstraints`, and `DROP INDEX` against an implicit covering
  structure does not tear down the constraint. So the bug's user-facing harm is
  the **non-idempotent / non-converging diff** (and the latent require-hint
  failure when paired with a create), not enforcement loss. Still fix it — a
  converged schema must diff empty.

- **Store mode** surfaces the exposed index via the `exposedImplicitIndexes`
  synthetic loop (`catalog.ts:160-162`), so the identical spurious drop arises
  there; the `DROP INDEX IF EXISTS` targets a non-materialized synthetic object.
  The fix is in the backend-agnostic differ + catalog marker, so it covers both;
  verify via the sqllogic phase under `test:store`.

## Design

Add a marker to `CatalogIndex` identifying an entry whose identity belongs to a
UNIQUE constraint (not to `CREATE/DROP INDEX`):

```ts
export interface CatalogIndex {
    name: string;
    tableName: string;
    ddl: string;
    definition: string;
    tags?: Readonly<Record<string, SqlValue>>;
    /**
     * True when this index is an *exposed implicit covering structure* — the
     * secondary BTree backing a UNIQUE constraint tagged
     * `quereus.expose_implicit_index`. Surfaced for introspection only; its
     * lifecycle is the originating constraint's (the named-constraint diff path),
     * so the schema differ MUST exclude it from the standalone-index
     * create/drop/rename buckets. Absent/false ⇒ an ordinary, differ-managed index.
     */
    implicit?: boolean;
}
```

(A `derivedFromConstraint: string` carrying the constraint name is an acceptable
alternative if a name is wanted for diagnostics; a boolean is sufficient for the
exclusion logic. Pick one — boolean preferred for simplicity.)

Set the marker at **both** surfacing sites in `collectSchemaCatalog`:

1. **Memory real-index loop** (`catalog.ts:145-152`): the exposure map already
   distinguishes exposed (`true`) / hidden (`false`, skipped) / ordinary
   (`undefined`). Mark the catalog entry `implicit: true` exactly when
   `exposed === true`; leave ordinary indexes unmarked.
2. **Store synthetic loop** (`catalog.ts:160-162`): every `SyntheticExposedIndex`
   from `exposedImplicitIndexes(...)` is exposed-implicit by construction → mark
   all of them.

Thread the marker through `indexSchemaToCatalog` (add an `implicit = false`
param, or set the field on the returned object at each call site — setting at the
call site keeps ordinary-index calls untouched).

In `computeSchemaDiff`, exclude marked entries from the differ's index view. The
cleanest single chokepoint is where `actualIndexes` is built
(`schema-differ.ts:281`):

```ts
const actualIndexes = new Map(
    actualCatalog.indexes
        .filter(i => !i.implicit)
        .map(i => [i.name.toLowerCase(), i]),
);
```

Filtering here removes marked entries from *all three* downstream consumers in
one place: index rename resolution (`resolveRenames`, ~312-322), the create/body
loop (~441-465, which only iterates *declared* indexes anyway), and the
orphan-drop loop (~466-469). Marked entries can never enter `indexesToCreate`
(they're never in `declaredIndexes`), `indexesToDrop`, `indexTagsChanges`, or a
rename op. This is preferable to a targeted skip inside the orphan loop alone,
because it also guarantees an exposed index can never be mis-consumed as a rename
target.

### Tag round-trip / drift

Tag drift on an exposed implicit index is **not declaratively expressible** as an
index: the declared source of truth is the constraint (`with tags (...)` on the
UNIQUE), not a `declare … index`. So the index buckets correctly ignore it —
constraint-tag drift flows through the named-constraint path
(`constraintTagsChanges`), and `ALTER INDEX … SET TAGS` on the exposed name is
already routed onto `uc.exposedIndexTags` at apply time
(`findExposedImplicitConstraintIndex` / `updateIndexTags`). No
`ALTER INDEX … SET TAGS` should ever be emitted by the differ for a marked entry
— filtering it from `actualIndexes` ensures that. No drop+recreate path exists
for it. (No extra code needed here; just confirm the filter prevents any index
tag-change emission for the exposed entry.)

### Collision safety

The implicit index name derives from the constraint (`uc.name ?? '_uc_<cols>'`),
and a user `declare … index` with that same name colliding is impossible by
construction (confirm there's no path where a declared index and an exposed
constraint resolve to the same name and both reach the index buckets). The filter
makes the marked actual invisible to the declared-index matching regardless, so
even a hypothetical name clash degrades to "declared index is created" rather
than a spurious drop of the constraint's structure.

## TODO

- Add `implicit?: boolean` (or `derivedFromConstraint?: string`) to `CatalogIndex`
  in `catalog.ts`, with the doc comment above.
- Set the marker in `collectSchemaCatalog`'s memory real-index loop (only when
  `exposed === true`) and in the store `exposedImplicitIndexes` loop (always).
  Thread it through `indexSchemaToCatalog`.
- In `computeSchemaDiff`, filter `i.implicit` out when building `actualIndexes`
  (schema-differ.ts ~281). Add a brief comment pointing back to the catalog
  marker so the exclusion is discoverable.
- Confirm the existing `introspection hiding` tests in
  `covering-structure.spec.ts` still pass: the exposed index MUST remain visible
  in `collectSchemaCatalog().indexes` (marker is additive, not a hide).
- Add a memory-backend regression test in `covering-structure.spec.ts` (e.g. a
  new `declarative idempotency` describe): declare schema with an exposed UNIQUE
  constraint → `apply schema main` → assert `computeSchemaDiff(declared, catalog)`
  yields `indexesToCreate == []` and `indexesToDrop == []` AND
  `generateMigrationDDL(diff, 'main') == []`, under both `allow` and
  `require-hint` policies. (Use `db.declaredSchemaManager.getDeclaredSchema('main')`
  to retrieve the AST, mirroring `emitDiffSchema`.)
- Add a sqllogic phase to `50-declarative-schema.sqllogic` (runs both memory and
  store via `test:store`): declare a table with an exposed UNIQUE constraint,
  `apply schema main`, then `diff schema main;` → `[]`. Keep it self-contained
  (drop the table at the end like the other phases).
- Run `yarn test` (memory) and `yarn test:store` (store) — both must stay green.
  Run lint on `packages/quereus`.
- Update `docs/schema.md` if it documents the differ's index buckets / exposed
  implicit index behavior (check; add a sentence that exposed implicit indexes
  are introspection-only and excluded from differ index lifecycle).
