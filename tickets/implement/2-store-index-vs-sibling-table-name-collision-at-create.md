description: Reject at CREATE time any store-backed object whose computed physical store name (`{schema}.{table}` / `{schema}.{table}_idx_{index}`) already names an existing data or index store — closing the silent shared-storage corruption where index `archive` on `t` and a sibling table `t_idx_archive` both map to `main.t_idx_archive`.
prereq:
files:
  - packages/quereus-store/src/common/store-module.ts        # create / createIndex / renameTable — add the collision guard + shared helper
  - packages/quereus-store/src/common/key-builder.ts         # buildDataStoreName / buildIndexStoreName — reuse, do NOT change the scheme
  - packages/quereus-store/test/create-table-conformance.spec.ts  # in-memory provider harness to copy for the new fast-lane spec
  - packages/quereus-plugin-leveldb/test/sibling-collision.spec.ts # persistent-provider companion; add reject cases here
  - packages/quereus/src/schema/manager.ts                   # getSchemaOrFail (public, line ~1297); createTable calls module.create BEFORE addTable; createIndex calls module.createIndex BEFORE appendIndexToTableSchema
  - packages/quereus/src/schema/schema.ts                    # Schema.getAllTables()
----

# CREATE-time physical store-name collision detection

## The structural ambiguity (recap)

Physical store names are built by string concatenation with a `_idx_` delimiter that is
itself a legal substring of any identifier:

- data store:  `buildDataStoreName(schema, table)`  → `{schema}.{table}`
- index store: `buildIndexStoreName(schema, table, index)` → `{schema}.{table}_idx_{index}`

So two distinct logical objects can produce the **same** physical store name:

| logical object                            | physical store name   |
|-------------------------------------------|-----------------------|
| index `archive` on table `t`              | `main.t_idx_archive`  |
| data store of table named `t_idx_archive` | `main.t_idx_archive`  |

If both are created, they share one physical store (one LevelDB directory / one IndexedDB
object store) and silently corrupt each other. The prior
`store-name-prefix-collision-sibling-tables` fix only closed the rename/drop *prefix-scan*
hole; it does not prevent the two objects from being created in the first place.

A third, subtler instance: **index-vs-index** across two tables — table `a` with index
`b_idx_c` and table `a_idx_b` with index `c` both compute `main.a_idx_b_idx_c`.

## Decision: CREATE-time collision detection (reject), not re-encoding

We reject the colliding CREATE with a clear, sited error rather than re-encoding the store
naming scheme. Rationale:

- **Surgical, no migration.** An unambiguous encoding (length-prefixing / escaped
  delimiter / separate data-vs-index sub-namespaces) would rename every on-disk directory
  and IndexedDB object store for *all* existing databases, needing a migration path, and
  would hurt the readable `{basePath}/{schema}/{table}` layout the providers rely on for
  path mapping and debuggability — disproportionate for an extreme edge case (a table
  literally named `t_idx_<x>` coexisting with an index `<x>` on `t`).
- **User-visible error beats silent corruption.** SQLite-style: some name combinations are
  simply disallowed; the user renames the table or the index.

The collision is a pure function of **names**, so detection = "does the candidate physical
store name already name an existing store in this provider?" The fix lives entirely in
`StoreModule` (the single owner of the naming scheme via `key-builder`); providers are
unchanged.

## Where the engine sequences these calls (verified)

- `SchemaManager.createTable` calls `module.create(db, baseTableSchema)` **before**
  `schema.addTable(...)` — so at `StoreModule.create` the new table is **not yet** in
  `db.schemaManager`. Enumerating siblings there yields only pre-existing objects (no
  self-collision false positive).
- `SchemaManager.createIndex` calls `module.createIndex(...)` **before**
  `appendIndexToTableSchema` + `schema.addTable(...)` — so the new index is **not yet**
  registered in the schema manager nor in the `StoreTable`'s cached schema at the point the
  guard runs (top of `createIndex`, before `getIndexStore`).

So neither candidate needs explicit self-exclusion, though the helper below dedups via a
`Set` and the candidate is checked for membership *after* the set is built from existing
objects only.

## Enumeration source (authoritative + wrapping-robust)

Build the set of currently-occupied physical store names from the **union** of:

1. `this.tables.values()` — this `StoreModule` instance's connected store tables. Each
   `StoreTable.getSchema()` gives the data store name plus one index store name per
   `schema.indexes[]`. This is always populated for store tables touched this session and
   is robust even when an isolation wrapper re-registers the table under the wrapper's
   module identity (the wrapper still delegates `create` to this `StoreModule`, which
   populates `this.tables`).
2. `db.schemaManager.getSchemaOrFail(schemaName).getAllTables()` filtered to
   `table.vtabModule === this && !table.isView` — catches store-backed tables that exist
   logically but have not been lazily connected into `this.tables` yet.

Names embed the schema prefix, so cross-schema entries can never collide; no explicit
per-schema filter on `this.tables` is needed. Memory-backed siblings and views are excluded
(they create no store in this provider) — including them would be a false-positive reject.

## The guard

Add a private helper and call it before any storage side-effect:

```
private collectOccupiedStoreNames(db: Database): Set<string> {
  const names = new Set<string>();
  const add = (s: TableSchema) => {
    names.add(buildDataStoreName(s.schemaName, s.name));
    for (const idx of s.indexes ?? []) names.add(buildIndexStoreName(s.schemaName, s.name, idx.name));
  };
  for (const t of this.tables.values()) add(t.getSchema());
  for (const t of db.schemaManager.getSchemaOrFail(/* target schema */).getAllTables()) {
    if (t.vtabModule === this && !t.isView) add(t);
  }
  return names;
}

private assertStoreNameFree(db, schemaName, candidate, sited): void {
  if (this.collectOccupiedStoreNames(db, schemaName).has(candidate))
    throw new QuereusError(<clear, sited message>, StatusCode.ERROR);
}
```

- **`StoreModule.create`** (after the existing `this.tables.has(tableKey)` duplicate check,
  **before** `this.provider.getStore(...)`): candidate = `buildDataStoreName(schemaName,
  tableSchema.name)`. The only real positive here is data-vs-index (data-vs-data is already
  prevented by engine table-name uniqueness). Message names the colliding index store and
  suggests renaming the table or the index.
- **`StoreModule.createIndex`** (at the top, after the `!table` NOTFOUND throw, **before**
  `this.provider.getIndexStore(...)`): candidate = `buildIndexStoreName(schemaName,
  tableName, indexSchema.name)`. Catches index-vs-sibling-table-data and index-vs-index.
- **`StoreModule.renameTable`** (after the existing `this.tables.has(newKey)` check,
  **before** the physical relocation): candidate = `buildDataStoreName(schemaName,
  newName)` — rejects renaming a table into a name already occupied by another object's
  index store (e.g. rename some table to `q_idx_archive` while `q` has index `archive`).
  The deeper "rename produces a colliding *index* store name (`newName_idx_x`)" variant is
  **out of scope** — parked in `tickets/backlog/store-rename-produces-colliding-index-store-name.md`.

Error code: `StatusCode.ERROR` (a structural naming conflict, not a data CONSTRAINT and not
UNSUPPORTED). Message must be sited (name the candidate physical store and the two
conflicting logical objects) and actionable ("rename the table or the colliding index").

## Why the guard must run before the side-effect (ordering is load-bearing)

- In `create`, `provider.getStore` **eagerly opens/creates** `main/t_idx_archive`. If the
  guard ran after, the new table `t_idx_archive` would open the *index store* of `t` as its
  data store and the first insert would corrupt `t`'s index. Guard first.
- In `createIndex`, `provider.getIndexStore` opens/creates the dir and `buildIndexEntries`
  immediately writes index keys into it — which is the sibling table's *data* store. Guard
  before `getIndexStore`.

## Acceptance

- Creating index `archive` on `t` while a table `t_idx_archive` exists → rejected
  (`StatusCode.ERROR`, sited message); the sibling table's rows/store are untouched.
- The reverse order — table `t_idx_archive` exists, then `create table t` + `create index
  archive on t` … actually the canonical reverse is: index `archive` on `t` exists, then
  `create table "t_idx_archive"` → rejected; `t`'s index store is untouched.
- Both orders covered across the in-memory provider (fast lane) and LevelDB (persistent).
- A reject leaves the connection usable (a subsequent non-colliding CREATE succeeds).
- Negative control: sibling table `t_idx_archive` coexisting with table `t` that has a
  *differently-named* index (`ix_b`) is **allowed** — no false-positive reject, and both
  tables read back their own rows.

## Edge cases & interactions

- **Both creation orders** — index-then-sibling-table AND sibling-table-then-index. Each
  must reject at the corresponding hook (`create` vs `createIndex`).
- **index-vs-index** — table `a` index `b_idx_c` then table `a_idx_b` index `c` (or the
  reverse): the second `createIndex` must reject (candidate `main.a_idx_b_idx_c` already
  occupied by the first index). Confirms the guard checks against *index* store names too,
  not only data store names.
- **No false positives (negative controls):** (a) sibling table `t_idx_x` + table `t` with
  index `ix_b` (different name) → allowed; (b) a *memory*-backed table named `t_idx_archive`
  must NOT block a store index `archive` on store table `t` (it owns no store in this
  provider) — the `vtabModule === this` filter; (c) a view named `t_idx_archive` must not
  block it (the `!isView` filter).
- **Not-yet-connected sibling:** a store table that exists in the catalog but has not been
  lazily `connect()`-ed this session must still be seen — covered by the schemaManager arm
  of the union. (Optional persistent-provider test: reopen → before touching the sibling,
  attempt the colliding CREATE → still rejected.)
- **Isolation wrapper:** when wrapped by `IsolationModule`, the registered `vtabModule` may
  be the wrapper, so the schemaManager arm sees zero `=== this` tables; the `this.tables`
  arm still catches every table this StoreModule created this session. Don't regress the
  isolation tests (`packages/quereus-store/test/isolated-store.spec.ts`).
- **Partial-failure / atomicity:** the guard throws *before* `getStore`/`getIndexStore`, so
  no store is opened/created, no catalog write, no schema-change event — fully no-op reject.
  Verify on LevelDB that the rejected op leaves no stray directory.
- **Reserved names** (`__catalog__`, `__stats__`) are unaffected — user data/index names
  always carry a `{schema}.` prefix and cannot equal the bare reserved names. No new check
  needed.
- **`IndexedDBProvider.invalidateCache` prefix scan** (`name.startsWith('{schema}.{table}_idx_')`,
  provider.ts ~line 207) still matches a *sibling* table `t_idx_x` when invalidating `t`.
  This collision-detection fix does NOT change that, but the over-invalidation is **benign**
  (it only drops valid cache entries → an extra read, never wrong data) and is explicitly
  out of scope. Do not grow scope to "fix" it; just leave the note.

## TODO

- Add `buildDataStoreName` / `buildIndexStoreName` to the `key-builder` imports in
  `store-module.ts` (alongside the existing `buildIndexKey` etc.).
- Implement `collectOccupiedStoreNames(db, schemaName)` and `assertStoreNameFree(...)`
  private helpers on `StoreModule`.
- Wire the guard into `create` (before `provider.getStore`), `createIndex` (top, before
  `provider.getIndexStore`), and `renameTable` (before physical relocation). Un-underscore
  the `_db` param of `createIndex` so the helper can read `db.schemaManager`.
- New fast-lane spec `packages/quereus-store/test/store-name-collision.spec.ts` using the
  in-memory provider harness copied from `create-table-conformance.spec.ts`: both creation
  orders reject (`StatusCode.ERROR`), index-vs-index rejects, negative controls allow,
  reject leaves the connection usable, sibling rows read back intact.
- Extend `packages/quereus-plugin-leveldb/test/sibling-collision.spec.ts` (persistent): the
  two creation orders reject; assert the pre-existing object's on-disk store/rows are intact
  and no stray directory was created for the rejected op.
- Run `yarn test` (fast lane); run `yarn test:store` only if diagnosing a store-specific
  interaction. Lint `packages/quereus` if any of its files change (none expected here).
