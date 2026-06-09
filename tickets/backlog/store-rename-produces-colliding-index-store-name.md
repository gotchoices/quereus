description: RENAME a store-backed table to a name whose computed *index* store names (`{schema}.{newName}_idx_{idx}`) collide with an existing data/index store is not guarded — the CREATE-time collision fix only checks the new *data* store name. The provider then relocates an index directory on top of another object's store and corrupts it.
files:
  - packages/quereus-store/src/common/store-module.ts        # renameTable — extend the assertStoreNameFree guard to cover each new index store name
  - packages/quereus-store/src/common/key-builder.ts         # buildIndexStoreName — the name the rename would produce
  - packages/quereus-plugin-leveldb/test/sibling-collision.spec.ts # add the persistent reject case here
----

# RENAME producing a colliding *index* store name

## Context

`store-index-vs-sibling-table-name-collision-at-create` added CREATE-time physical
store-name collision detection in `StoreModule` (`assertStoreNameFree` /
`collectOccupiedStoreNames`). The `renameTable` arm of that fix guards **only** the
renamed table's new **data** store name:

```
candidate = buildDataStoreName(schemaName, newName)
```

That catches renaming a table *into* a name already occupied by another object's
store (including the table's own index-store name). It does **not** check the new
**index** store names the rename will produce for the renamed table's secondary
indexes.

## The unguarded collision

A store-backed table's rename relocates not just its data directory but every index
directory, re-deriving each as `buildIndexStoreName(schema, newName, idx.name)` =
`{schema}.{newName}_idx_{idx}`. If any existing data/index store already occupies one
of those names, the provider's relocation writes the moved index directory on top of
the existing object and silently corrupts it.

Concrete reproduction:

| step | object | physical store |
|------|--------|----------------|
| 1 | table `t` with index `archive`        | data `main.t`, index `main.t_idx_archive` |
| 2 | sibling table `foo_idx_archive`       | data `main.foo_idx_archive` |
| 3 | `alter table t rename to foo`         | new data `main.foo` (free — passes the existing guard) |
|   | …but t's index `archive` re-derives to | `main.foo_idx_archive` == the sibling table's data store → **collision** |

The current `renameTable` guard only checks `main.foo` (the data store), so the
rename proceeds and the provider relocates `main.t_idx_archive` → `main.foo_idx_archive`,
clobbering the `foo_idx_archive` table's rows.

## Required behavior

Before the physical relocation in `StoreModule.renameTable`, reject the rename when
**any** of the renamed table's new index store names
(`buildIndexStoreName(schemaName, newName, idx.name)` for each `idx` in the table's
schema) already names an existing data or index store — reusing the same
`collectOccupiedStoreNames` occupancy set the data-store guard uses.

- The occupancy set must exclude the renamed table's **own** current stores
  (`{schema}.{oldName}` and `{schema}.{oldName}_idx_*`), since those legitimately
  move with the table. (The CREATE-time fix deliberately omitted self-exclusion
  because at that point the simplest self-collision — rename into the table's own
  index-store name — is itself the hazard and is better rejected; this deeper
  index-name check is the case where self-exclusion is genuinely required, so the
  occupancy/exclusion handling needs revisiting here.)
- Error: `StatusCode.ERROR`, sited (name the candidate index store, the renamed
  table + its index, and the conflicting existing object), actionable ("rename the
  table to a different name, or drop/rename the conflicting object").
- Must run before any provider relocation so the reject is a full no-op.

## Acceptance

- The table reproduction above (`t` w/ index `archive`, sibling `foo_idx_archive`,
  `rename t → foo`) is rejected; the sibling's rows/store are untouched and no stray
  directory is created.
- The index-vs-index variant (rename producing `{newName}_idx_{x}` equal to another
  table's existing index store) is likewise rejected.
- Negative control: a normal rename (`t → t2`, no derived index name collides) still
  succeeds and relocates all index directories.
- Covered across the in-memory provider (fast lane,
  `packages/quereus-store/test/store-name-collision.spec.ts`) and LevelDB
  (`packages/quereus-plugin-leveldb/test/sibling-collision.spec.ts`).

## Out of scope / notes

- A full re-encoding of the store naming scheme (length-prefixing / escaped
  delimiter) remains out of scope — same rationale as the CREATE-time ticket
  (surgical reject beats a migration of every on-disk directory).
- The in-memory harness `renameTableStores` in the store tests moves the data store
  before the index stores; under a derived-name collision that ordering itself can
  clobber — a correct provider must order/stage moves to avoid transient overwrite.
  The guard above makes that moot by rejecting before relocation, but if the guard is
  ever bypassed the provider ordering is a second latent hazard worth hardening.
