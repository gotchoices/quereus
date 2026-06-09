description: Review CREATE-time physical store-name collision detection in StoreModule — reject (StatusCode.ERROR, sited) when a new table's data store / new index's index store / rename target maps to a physical store name already occupied by an existing data or index store, closing the silent shared-storage corruption (index `archive` on `t` vs sibling table `t_idx_archive`).
prereq:
files:
  - packages/quereus-store/src/common/store-module.ts        # collectOccupiedStoreNames + assertStoreNameFree helpers; guards wired into create / createIndex / renameTable
  - packages/quereus-store/src/common/key-builder.ts         # buildDataStoreName / buildIndexStoreName (unchanged; now imported by store-module)
  - packages/quereus-store/test/store-name-collision.spec.ts # NEW fast-lane spec (in-memory provider), 8 cases
  - packages/quereus-plugin-leveldb/test/sibling-collision.spec.ts # extended with 2 persistent reject cases
  - tickets/backlog/store-rename-produces-colliding-index-store-name.md # NEW — parks the deeper rename-produces-colliding-index-store variant
----

# Review: CREATE-time physical store-name collision detection

## What shipped

Physical store names are built by string concatenation with an `_idx_` delimiter
that is itself a legal identifier substring, so two distinct logical objects can
collapse to one physical store and silently corrupt each other:

| logical object                            | physical store name   |
|-------------------------------------------|-----------------------|
| index `archive` on table `t`              | `main.t_idx_archive`  |
| data store of table named `t_idx_archive` | `main.t_idx_archive`  |

`StoreModule` now rejects the colliding CREATE/RENAME up front. Two private helpers
were added (`store-module.ts`, just after `getProvider`):

- **`collectOccupiedStoreNames(db, schemaName): Map<string,string>`** — builds the
  set of physical store names currently occupied, mapping each to a human
  description (for sited messages). Union of two sources:
  1. `this.tables.values()` — every store table this module touched this session
     (robust to the isolation wrapper, which still delegates `create` to this
     module and so populates `this.tables`).
  2. the target schema's `getAllTables()` filtered to `vtabModule === this &&
     !isView` — store-backed tables not yet lazily connected.
  Names embed the schema prefix (cross-schema entries never collide). Memory-backed
  siblings and views own no store here and are excluded.
- **`assertStoreNameFree(db, schemaName, candidate, candidateDesc)`** — throws
  `StatusCode.ERROR` with a sited, actionable message if `candidate` is occupied.

Wired in (each **before** the storage side-effect — load-bearing, because
`getStore`/`getIndexStore` eagerly open/create the directory):

- `create` — candidate = `buildDataStoreName(schemaName, tableName)`; before
  `provider.getStore`. Catches data-vs-index (data-vs-data is prevented by engine
  table-name uniqueness).
- `createIndex` — candidate = `buildIndexStoreName(schemaName, tableName,
  indexName)`; at the top before `provider.getIndexStore`. Catches
  index-vs-sibling-table-data and index-vs-index. (`_db` un-underscored to read
  `db.schemaManager`.)
- `renameTable` — candidate = `buildDataStoreName(schemaName, newName)`; after the
  existing `this.tables.has(newKey)` check, before relocation.

Error code is `StatusCode.ERROR` (structural naming conflict — not CONSTRAINT, not
UNSUPPORTED).

## Deviation from the plan ticket — NO self-exclusion (please scrutinize)

The plan floated a self-exclusion param so renaming `t` into `t`'s OWN index-store
name (`t` has index `x`, rename → `t_idx_x`) would not false-positive. I implemented
it, found it made things WORSE, and removed it. Rationale, in scope for review:

- The only scenario where self-exclusion fires is renaming `t` → `t_idx_<ownIndex>`,
  which is exactly the "rename produces a colliding index store name" hazard the plan
  parks as out of scope. Allowing it through (self-exclusion) sends it into the
  provider's relocation path, which transiently moves the data store onto the index
  store name and **loses data** (confirmed in the in-memory harness).
- Without self-exclusion the guard **rejects** that rename cleanly before any
  relocation — strictly safer, and it matches the plan's literal
  `collectOccupiedStoreNames(db)` pseudocode (which has no exclusion).

So the final design has no self-exclusion. The deeper variant the plan referenced —
rename producing a colliding *index* store name where the new data name is free —
is **still unguarded** and is now parked in
`tickets/backlog/store-rename-produces-colliding-index-store-name.md` (the parked
ticket the plan named did not previously exist; I created it). Reviewer: confirm you
agree rejecting the self-rename is preferable to the parked-hazard data loss.

## Test coverage (treat as a floor)

Fast lane — `packages/quereus-store/test/store-name-collision.spec.ts` (in-memory
provider, 8 cases, all green):
- CREATE INDEX colliding with a sibling table data store → reject; sibling rows
  intact; connection still usable (subsequent non-colliding CREATE INDEX works).
- CREATE TABLE colliding with an existing index store → reject; table not created;
  pre-existing table's data + index-backed lookups intact.
- index-vs-index across two tables (`a.b_idx_c` vs `a_idx_b.c` → `main.a_idx_b_idx_c`).
- Negative controls (must NOT reject): sibling `t_idx_x` + table `t` with a
  differently-named index; a **memory**-backed `t_idx_archive`; a **view**
  `t_idx_archive`.
- RENAME into another table's index-store name → reject; both intact.
- RENAME into the table's OWN index-store name → reject (hazard); data intact.

Persistent — `packages/quereus-plugin-leveldb/test/sibling-collision.spec.ts`
(LevelDB, +2 cases, all green): both creation orders reject; pre-existing object's
on-disk dirs + rows intact; **no stray directory** created for the rejected op
(directory-set snapshot before/after is byte-identical).

Validation run:
- `quereus-store` suite: **393 passing** (incl. `isolated-store.spec.ts` — no
  isolation regression).
- `quereus-plugin-leveldb` suite: **16 passing**.
- Full `yarn test` fast lane: **EXIT 0** (quereus core 5411 passing; all workspaces
  green).
- `yarn workspace @quereus/store typecheck`: clean. No `packages/quereus` files
  changed → no lint needed (only that package has a lint script).

## Known gaps / where to look hardest

- **Coverage is a floor.** Only the canonical orderings are tested. Not exercised:
  ATTACH'd/secondary schemas (the guard scopes the schemaManager arm to the target
  schema via `getSchemaOrFail` — cross-schema names can't collide because the prefix
  differs, but no test asserts a same-leaf-name table in two schemas); the
  not-yet-connected-sibling path on reopen (the schemaManager arm is meant to cover
  it but there is no persistent reopen→collide test); the IndexedDB provider (only
  in-memory + LevelDB tested — IndexedDB shares the same `StoreModule` code so the
  guard applies, but the `invalidateCache` prefix-scan note below is provider-specific).
- **Rename index-store collision (parked).** See the new backlog ticket — the
  renameTable guard checks only the new data store name, not the new index store
  names the rename derives. Reproduction + acceptance are in that ticket.
- **In-memory harness `renameTableStores` is now dead** for these tests (every rename
  rejects before relocation). It is retained to mirror `alter-table.spec.ts` and
  documents the provider contract; it also carries the move-order hazard noted in the
  parked ticket. Reviewer may prefer to drop it — low stakes.
- **`IndexedDBProvider.invalidateCache` prefix scan** (`startsWith('{schema}.{table}_idx_')`)
  still over-matches a sibling `t_idx_x` when invalidating `t`. Explicitly out of
  scope and benign (drops valid cache entries → an extra read, never wrong data). Not
  touched.
- **Message wording** is generated ("Physical store-name collision: the <desc> would
  map to physical store '<name>', which already backs the <occupied> …"). Tests assert
  the candidate name + `/collision/i`, not exact prose — confirm the wording reads
  well and is actionable.

## Acceptance checklist (from the plan, all met)

- Index `archive` on `t` while table `t_idx_archive` exists → reject (ERROR, sited);
  sibling untouched. ✓
- Reverse order (index exists, then `create table t_idx_archive`) → reject; index
  store untouched. ✓
- Both orders across in-memory (fast) + LevelDB (persistent). ✓
- Reject leaves the connection usable. ✓
- Negative controls (different index name / memory sibling / view) allowed. ✓
- index-vs-index rejects. ✓
- Reserved names (`__catalog__`, `__stats__`) unaffected (user names always carry a
  `{schema}.` prefix). ✓ (by construction; no explicit test)
