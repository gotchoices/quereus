<!-- resume-note -->
RESUME: A prior agent run on this ticket did not complete.
  Prior run: 2026-06-10T01:36:56.043Z (agent: claude)
  Log file: C:\projects\quereus\tickets\.logs\store-rename-produces-colliding-index-store-name.review.2026-06-10T01-36-56-043Z.log
Read the log to see what was done. Resume where it left off.
If the prior run hit a timeout or repeated error, be cautious not to rush into the same situation.
<!-- /resume-note -->
----
description: Review — RENAME collision guard now covers relocated index store names: renameTable guards every introduced physical name (new data store + each `{newName}_idx_{x}`) against a once-collected occupied map before any side effect; LevelDB renameTableStores pre-scans ALL destinations before moving any directory.
files:
  - packages/quereus-store/src/common/store-module.ts             # renameTable guard (~1380-1420), assertStoreNameFree optional `occupied` param (~247), collectOccupiedStoreNames doc (~202)
  - packages/quereus-store/test/store-name-collision.spec.ts      # 3 new rename tests (collision, negative control, own-footprint swap)
  - packages/quereus-plugin-leveldb/src/provider.ts               # renameTableStores all-destinations pre-scan (~162)
  - packages/quereus-plugin-leveldb/test/sibling-collision.spec.ts # rename-collision atomicity test (no dir moved on reject)
----

# RENAME producing a colliding index store name — implemented

## What changed

**`StoreModule.renameTable`** (store-module.ts): the `existing`/`currentSchema`/`indexNames`
capture was hoisted above the collision guard (capture is read-only). The guard now collects
the occupied-name map **once** via `collectOccupiedStoreNames` and checks **every** physical
name the rename introduces — `buildDataStoreName(schema, newName)` plus
`buildIndexStoreName(schema, newName, idx)` for each index on the renamed table — before the
first side effect (coordinator commit, disconnect, `tables`/`stores`/`coordinators`
evictions, physical relocation). A colliding rename is a clean no-op: in-memory handles are
not evicted, so the very next statement on the old name works without recovery.

**`assertStoreNameFree`** gained an optional trailing `occupied?: Map<string, string>`
parameter so multi-candidate callers don't rebuild the map per call. The two other call
sites (`create`, `createIndex`) are unchanged and still self-collect. Message shape
(sited `StatusCode.ERROR`, names candidate physical store + both logical objects) unchanged.

**No self-exclusion** (deviation from the original fix ticket's note, per the implement
ticket's design): the renamed table's own current stores stay in the occupied set. Every
introduced-name-vs-own-store overlap is a footprint-swap rename providers cannot relocate
safely (move-ordering hazard), and no benign rename produces such an overlap — so no false
rejects. Both stale comment blocks (collectOccupiedStoreNames doc, renameTable guard) were
rewritten with this justification; backlog-ticket references dropped.

**LevelDB `renameTableStores`** (provider.ts): now plans every directory move up front
(`planMove` checks each destination's existence and throws before anything moves), then
closes handles, then performs the moves. Previously only the data dir's destination was
checked and the index-dir loop renamed unchecked — on POSIX, rename onto an existing
*empty* dir silently clobbers; otherwise a raw error surfaced after the data dir had
already moved (half-renamed table). On reject the provider is now a full no-op (handles
aren't even closed, since the pre-scan precedes the close loop).

**IndexedDB provider**: unchanged, as the ticket predicted — it already builds the full
rename list with per-destination `hasObjectStore` checks before relocating anything.

## Test coverage (validation entry points)

`packages/quereus-store/test/store-name-collision.spec.ts` (fast lane, in-memory provider —
its `renameTableStores.move` silently overwrites destinations, which is exactly what makes
the intact-sibling assertions meaningful):

- **Primary repro**: `t` (index `x`) renamed to `u` while sibling table `"u_idx_x"` exists →
  `QuereusError`/`StatusCode.ERROR` naming `main.u_idx_x`; sibling rows intact; `t` readable
  with working index on the next statements (atomicity, no recovery).
- **Negative control**: sibling `"u_idx_y"`, index `x` → rename succeeds; index-backed
  lookup on `u` works; sibling intact.
- **Own-footprint swap**: table `"u_idx_x"` with index `x` renamed to `u` → rejected
  (documents the no-self-exclusion stance).
- Pre-existing tests stay green, including "rejects renaming a table into its OWN
  index-store name" (comment updated — hazard no longer "parked").

`packages/quereus-plugin-leveldb/test/sibling-collision.spec.ts`:

- Same primary scenario against real directories → rejected AND `mainDirs()` unchanged —
  no directory moved on reject (guard fires before provider relocation; provider pre-scan
  is the backstop).

Manual repro (any store-backed db):
```sql
create table t (id integer primary key, b integer) using store;
create index x on t (b);
create table "u_idx_x" (id integer primary key, v integer) using store;
alter table t rename to u;   -- must reject naming main.u_idx_x; both tables intact after
```

## Validation performed

- `yarn build` (quereus-store, quereus-plugin-leveldb) + `yarn typecheck` on both: clean.
- `yarn test` (full fast lane, repo root): all suites passing (quereus 5550 passing /
  9 pending; store 403; leveldb 17; all other workspaces green).

## Known gaps / honest notes for review

- **`yarn test:store` not run** (LevelDB-backed run of the quereus logic tests). The
  ALTER-rename store path is directly exercised by both unit suites above and the provider
  diff is confined to `renameTableStores`, so I judged the slow lane unnecessary; reviewer
  may disagree.
- **Occupancy-set blind spots are pre-existing and unchanged**: `collectOccupiedStoreNames`
  enumerates this module's session tables + the schema catalog. An orphaned on-disk
  directory not present in either (e.g. crash leftovers) is invisible to the guard — for
  that case the LevelDB pre-scan backstop fires instead, which is loud and FS-atomic but
  happens *after* renameTable's coordinator commit/disconnect/evictions (the table
  reconnects lazily under its old name; catalog DDL was not yet rewritten). Same class of
  behavior as before, now strictly narrower and never partial on disk.
- **LevelDB pre-scan TOCTOU**: destination-existence checks and the subsequent renames are
  not one atomic FS operation. Single-process assumption, same as the pre-existing
  data-dir check.
- **LevelDB `storePaths` staleness on rename** is pre-existing and untouched: rename
  computes paths directly from `basePath`, old map entries linger harmlessly.
- The in-memory test provider's `move` still silently overwrites — deliberate (it's the
  corruption oracle for the fast-lane tests), but it means the fast lane validates the
  StoreModule guard only, not a provider backstop.
