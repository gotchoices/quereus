----
description: Extend StoreModule.renameTable's collision guard to relocated INDEX store names — renaming `t`→`u` relocates each `t_idx_x` to `u_idx_x`, which may already name a sibling table's data store; today the guard only checks the new data store name, so the rename proceeds and aliases/clobbers the sibling's store.
files:
  - packages/quereus-store/src/common/store-module.ts             # renameTable (~1353), assertStoreNameFree (~247), collectOccupiedStoreNames (~212)
  - packages/quereus-store/test/store-name-collision.spec.ts      # fast-lane regression tests (in-memory provider)
  - packages/quereus-plugin-leveldb/src/provider.ts               # renameTableStores (~162) — defense-in-depth: pre-scan ALL destinations before moving any
  - packages/quereus-plugin-leveldb/test/sibling-collision.spec.ts # persistent companion: rename-collision atomicity (no dir moved on reject)
  - packages/quereus-plugin-indexeddb/src/provider.ts             # renameTableStores (~146) — already pre-checks all destinations before relocating; no change expected
----

# RENAME producing a colliding index store name — guard relocated index stores

## Reproduction (confirmed)

With the in-memory KV provider used by `store-name-collision.spec.ts`:

```sql
create table t (id integer primary key, b integer) using store;
create index x on t (b);                                   -- index store main.t_idx_x
create table "u_idx_x" (id integer primary key, v integer) using store;  -- data store main.u_idx_x
alter table t rename to u;                                  -- new data store main.u is FREE → guard passes
```

The rename **succeeds** (no reject). `renameTableStores` then relocates `main.t_idx_x` →
`main.u_idx_x`, which is the sibling table's data store. The in-memory provider's `move`
silently overwrites the destination (`stores.set(to, s)`), so the sibling is clobbered —
silent corruption in the fast lane. The persistent providers fail loud-but-partial instead
(see below).

## Root cause

`StoreModule.renameTable` (store-module.ts ~1379-1385) calls `assertStoreNameFree` for
exactly one candidate: `buildDataStoreName(schemaName, newName)`. The relocated index store
names — `buildIndexStoreName(schemaName, newName, idx.name)` for each index on the renamed
table — are never checked, yet the rename introduces them just as surely as the data store
name.

Reachable collision class: a relocated index name `{schema}.{newName}_idx_{x}` can only
collide with a **sibling table's data store** (table literally named `{newName}_idx_{x}`) or
the renamed table's own current stores. It cannot collide with another table's *index*
store without that table being named `{newName}` — which the existing data-store check
already rejects. (Split `{T}_idx_{I} = {newName}_idx_{x}` at the first `_idx_`: T must be
`{newName}`.)

Provider behavior today (why this is messy, not just loud):

- **LevelDB** (`provider.ts` ~162-200): the *data*-dir move checks destination-exists and
  throws; the *index*-dir loop does **not** — `fs.promises.rename(oldIndexPath, newIndexPath)`
  runs unchecked. On POSIX, renaming onto an existing **empty** directory succeeds → silent
  clobber; otherwise a raw `ENOTEMPTY`/`EPERM` surfaces **after the data dir already moved**
  → half-renamed table.
- **IndexedDB** (`provider.ts` ~146-183): builds the full rename list with per-destination
  `hasObjectStore` checks **before** any relocation, so it rejects atomically — but as a raw
  provider `Error`, not a sited `StatusCode.ERROR`, and only after `renameTable` has already
  committed the coordinator, disconnected the handle, and evicted `this.tables`/`stores`/
  `coordinators` for the old key.

## Design

### Guard all introduced names in `renameTable`, before any side effect

In `renameTable`, hoist the read-only `currentSchema` capture (~1389-1391) **above** the
guard so the index list is available, then check every physical name the rename introduces:

- `buildDataStoreName(schemaName, newName)` (existing check), and
- `buildIndexStoreName(schemaName, newName, idx.name)` for each `idx` of `currentSchema.indexes`.

All checks must run before the first side effect (the coordinator `commit()` at ~1404, the
`disconnect()`, the `tables/stores/coordinators` evictions, and the physical relocation), so
a colliding rename is a clean no-op.

Collect the occupied-name map **once** and test all candidates against it, rather than
calling `assertStoreNameFree` N+1 times (it rebuilds the map per call). Either add a
sibling helper that takes a precomputed map plus a candidate list, or refactor
`assertStoreNameFree` to accept an optional precomputed map — implementer's choice; keep the
sited, actionable message shape (candidate physical store + both logical objects).

### No self-exclusion (deviation from the fix ticket's note — rationale)

The fix ticket suggested excluding the renamed table's own current stores from the occupied
set ("they are sources, not collisions"). **Don't.** Every overlap between an introduced
name and an own current store is a footprint-swap rename that providers cannot relocate
safely today:

- new data store == own index store (`t` with index `x` → rename to `t_idx_x`): already
  intentionally rejected, with a regression test (`store-name-collision.spec.ts` ~205) and
  comments citing this ticket.
- new index store == own old data store (table `u_idx_x` with index `x` → rename to `u`):
  only safe if the provider moves the data dir before the index dir; IndexedDB pre-checks
  all destinations before moving anything and would reject it anyway.
- new index store == own old index store (table `a` with indexes `b_idx_c` and `c` → rename
  to `a_idx_b`): same move-ordering hazard, pathological.

No *benign* rename produces an introduced name equal to one of the table's own current
store names, so keeping own stores in the set causes no false rejects — it just keeps the
conservative reject uniform and the atomicity guarantee trivially true.

### Update stale comments

Both comment blocks that cite this ticket as *parked in backlog* must be rewritten, since
the guard now covers the hazard properly:

- `collectOccupiedStoreNames` doc, store-module.ts ~202-210 ("No self-exclusion …" — keep
  the conclusion, update the justification and drop the backlog reference).
- the guard comment inside `renameTable`, ~1369-1378.

### Defense-in-depth: LevelDB `renameTableStores` pre-scan

Mirror IndexedDB's shape: check **all** destinations (new data path *and* every new index
path) for existence up front, throwing before any `fs.promises.rename`, instead of the
current data-only check and unchecked index loop. This keeps the provider itself atomic on
reject even when called outside `StoreModule` (and removes the POSIX empty-dir silent
clobber). IndexedDB's provider already does this — no change there.

## Regression tests

`packages/quereus-store/test/store-name-collision.spec.ts` (fast lane, in-memory provider —
note its `renameTableStores.move` silently overwrites, which is exactly what makes the
intact-sibling assertions meaningful):

- rename `t`→`u` where `t` has index `x` and sibling table `"u_idx_x"` exists → rejected
  with `QuereusError`/`StatusCode.ERROR`, message names `main.u_idx_x`; sibling rows intact;
  `t` still reachable under its old name with a working index (atomicity: nothing moved,
  in-memory handles not evicted — a follow-up `select` on `t` must not need recovery).
- negative control: sibling `"u_idx_y"` exists, `t`'s index is `x` → rename `t`→`u`
  succeeds; both tables fully usable afterward (index-backed lookup on `u` works).
- own-footprint swap: table `"u_idx_x"` with index `x` renamed to `u` → rejected
  (documents the conservative no-self-exclusion stance).
- existing test "rejects renaming a table into its OWN index-store name" must stay green.

`packages/quereus-plugin-leveldb/test/sibling-collision.spec.ts` (persistent companion):

- same primary scenario (rename `t`→`u`, sibling `"u_idx_x"`) → rejected, and `mainDirs()`
  is unchanged — **no directory moved on reject** (this asserts the guard fires before the
  provider relocation, and the provider pre-scan as backstop).

## TODO

- Hoist `currentSchema`/index-name capture above the collision guard in `renameTable`.
- Guard all introduced physical names (new data store + every relocated index store) against
  a once-collected occupied map; sited `StatusCode.ERROR` before any side effect.
- Update the two stale comment blocks in store-module.ts that cite this ticket as parked.
- LevelDB `renameTableStores`: pre-scan all destinations (data + index dirs) before moving
  anything; remove the unchecked index-loop rename hazard.
- Add the fast-lane regression tests to store-name-collision.spec.ts (collision, negative
  control, own-footprint swap).
- Add the persistent atomicity test to leveldb sibling-collision.spec.ts.
- Run `yarn test` (fast lane) and the leveldb plugin spec; `yarn test:store` only if the
  store-path logic tests are in doubt.
