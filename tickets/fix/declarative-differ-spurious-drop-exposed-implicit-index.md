description: The declarative schema differ emits a spurious `DROP INDEX IF EXISTS <name>` for an exposed implicit covering index (a UNIQUE constraint tagged quereus.expose_implicit_index). Re-applying/diffing a stable schema is non-idempotent, and under renamePolicy=require-hint it hard-errors. Affects both memory (pre-existing) and store (newly activated) backends.
prereq:
files:
  - packages/quereus/src/schema/schema-differ.ts (computeSchemaDiff — index create/drop buckets; lines ~441-468)
  - packages/quereus/src/schema/catalog.ts (collectSchemaCatalog surfaces exposed implicit indexes as CatalogIndex; exposedImplicitIndexes / implicitCoveringIndexExposure)
  - packages/quereus/src/schema/catalog.ts (CatalogIndex interface — candidate site for an `implicit`/`derivedFromConstraint` marker)
  - packages/quereus/src/runtime/emit/schema-declarative.ts (apply/diff schema entry points that call collectSchemaCatalog + computeSchemaDiff)
  - packages/quereus/test/covering-structure.spec.ts (introspection-hiding tests — natural home for an idempotency regression test)
----

## Symptom

Declare a table whose UNIQUE constraint opts its implicit covering index into
catalog visibility, apply it, then re-diff against the live catalog — the diff is
NOT empty. It contains a phantom index drop:

```sql
declare schema main {
    table ExpoTbl {
        id INTEGER PRIMARY KEY,
        vin TEXT,
        constraint uq_expo_vin unique (vin) with tags ("quereus.expose_implicit_index" = true)
    }
}
apply schema main;
-- re-diff (collectSchemaCatalog + computeSchemaDiff) yields:
--   indexesToDrop = ["uq_expo_vin"]
--   migration DDL = ["DROP INDEX IF EXISTS uq_expo_vin"]
```

Confirmed empirically (memory mode) during review of
`store-exposed-implicit-index-addressable`:

```
ACTUAL INDEXES: [ 'uq_expo_vin' ]
MIGRATION DDL: [ 'DROP INDEX IF EXISTS uq_expo_vin' ]
```

## Root cause

An exposed implicit covering index is surfaced in `collectSchemaCatalog` as a
`CatalogIndex` (so `schema()` / `index_info()` / catalog introspection can see it)
— but its lifecycle is governed by the originating UNIQUE *constraint*, not by
`CREATE/DROP INDEX`. The differ does not know this:

- The constraint is declared as a *table constraint*, so it lands in the
  declared-table bucket and is correctly matched by the named-constraint diff
  (no churn there).
- The same object ALSO appears in `actualCatalog.indexes`, but there is no
  matching entry in `declaredIndexes` (a `declare ... index` item) — so the
  drop-orphan loop (`schema-differ.ts` ~line 466-468:
  `if (!declaredIndexes.has(name)) diff.indexesToDrop.push(name)`) schedules it
  for deletion.

The exposed index is effectively double-counted: matched as a constraint, then
dropped as a standalone index.

## Why it matters

- **Non-idempotent apply.** Re-applying an unchanged declarative schema produces
  a migration (`DROP INDEX …`) instead of a no-op — violating the declarative
  contract that a converged schema diffs empty.
- **`require-hint` hard error.** Under `apply schema … with renamePolicy =
  require-hint`, an unhinted drop is an error, so the apply *fails* rather than
  silently mis-migrating.
- **Runtime effect of the drop.** In memory mode the materialized covering index
  is the enforcement structure; dropping it (or attempting to) on every apply is
  at best wasteful and at worst weakens UNIQUE enforcement. In store mode the
  index is synthetic (not materialized), so `DROP INDEX IF EXISTS` targets a
  non-existent physical object — behavior should be verified.

## Scope / history

- **Pre-existing in memory mode.** At the parent commit of
  `store-exposed-implicit-index-addressable` (`d6585fd8^`),
  `collectSchemaCatalog` already surfaced exposed implicit indexes
  (`catalog.ts:150`, `exposed === false` skip ⇒ exposed=true is pushed). The
  exposed-implicit-index feature shipped with this latent differ bug.
- **Newly activated for store mode.** That ticket added the
  `exposedImplicitIndexes` synthetic loop so the store catalog now also surfaces
  the exposed index — extending the identical spurious-drop to the store backend
  (where, pre-feature, no such index appeared in the catalog at all).
- The existing store/memory test suites do NOT catch it: Phase 38 of
  `50-metadata-tags.sqllogic` exercises addressability via plain `CREATE TABLE` +
  `ALTER INDEX`, never `apply schema`, so no re-diff is ever computed over an
  exposed constraint.

## Expected behavior

Diffing/applying a declarative schema whose UNIQUE constraint exposes its
implicit covering index must be **idempotent**: a converged schema yields
`indexesToCreate == []` and `indexesToDrop == []`, with no `DROP INDEX` for the
exposed implicit index, under every `renamePolicy` (including `require-hint`).
The constraint continues to be diffed/managed via the named-constraint path; the
exposed index is introspection-only and must not enter the standalone-index
create/drop buckets.

A change to the constraint's *user tags* on the exposed index
(`ALTER INDEX … SET/ADD/DROP TAGS`, stored on `UniqueConstraintSchema.exposedIndexTags`
in store mode / `IndexSchema.tags` in memory) is out of scope for the index
create/drop buckets here, but if the differ ever surfaces an
`ALTER INDEX … SET TAGS` for it, that path must round-trip without a
drop+recreate. Consider whether tag drift on an exposed implicit index is even
expressible declaratively (the constraint, not a `declare … index`, is the
declared source of truth) — it may simply be a no-op the differ should ignore.

## Suggested direction (hint, not a plan)

The differ needs to recognize that an actual `CatalogIndex` is an
exposed-implicit-covering index whose identity belongs to a UNIQUE constraint,
and exclude it from the standalone-index create/drop logic. One clean option: add
a marker to `CatalogIndex` (e.g. `implicit: true` or
`derivedFromConstraint: <name>`), set at BOTH surfacing sites in
`collectSchemaCatalog` (the memory real-index loop where `exposed === true`, and
the store `exposedImplicitIndexes` loop), and have `computeSchemaDiff` skip
marked entries in the orphan-drop loop (and never expect them in
`declaredIndexes`). Validate the interaction with `require-hint` and with a table
that ALSO has a same-named explicit index is impossible-by-construction (the
implicit name derives from the constraint), but confirm there is no collision
path.

## Acceptance

- A regression test (both backends — e.g. a `covering-structure.spec.ts`
  idempotency case and/or a `50-declarative-schema.sqllogic` phase) asserting:
  declare + apply a table with an exposed UNIQUE constraint ⇒ a second
  diff/apply is empty (no index create, no index drop), under `allow` and
  `require-hint`.
- Memory full suite and store full suite remain green.
