----
description: RENAME collision guard now covers relocated index store names — renameTable guards every introduced physical name (new data store + each `{newName}_idx_{x}`) against a once-collected occupied map before any side effect; LevelDB renameTableStores pre-scans ALL destinations before moving any directory. Reviewed and complete.
files:
  - packages/quereus-store/src/common/store-module.ts             # renameTable guard (~1392-1420), assertStoreNameFree optional `occupied` param (~252), collectOccupiedStoreNames doc (~202)
  - packages/quereus-store/test/store-name-collision.spec.ts      # 3 rename tests (collision, negative control, own-footprint swap)
  - packages/quereus-plugin-leveldb/src/provider.ts               # renameTableStores all-destinations pre-scan (~170)
  - packages/quereus-plugin-leveldb/test/sibling-collision.spec.ts # rename-collision atomicity test (no dir moved on reject)
  - docs/store.md                                                 # collision-guard note added during review
----

# RENAME producing a colliding index store name — complete

## What changed (implement stage, commit 53139de4)

**`StoreModule.renameTable`**: the `existing`/`currentSchema`/`indexNames` capture was
hoisted above the collision guard. The guard collects the occupied-name map **once** via
`collectOccupiedStoreNames` and checks **every** physical name the rename introduces —
`buildDataStoreName(schema, newName)` plus `buildIndexStoreName(schema, newName, idx)` for
each index on the renamed table — before the first side effect (coordinator commit,
disconnect, `tables`/`stores`/`coordinators` evictions, physical relocation). A colliding
rename is a clean no-op; the next statement on the old name works without recovery.

**`assertStoreNameFree`** gained an optional trailing `occupied?: Map<string, string>`
parameter so multi-candidate callers don't rebuild the map per call; `create`/`createIndex`
call sites unchanged. Message shape (sited `StatusCode.ERROR`) unchanged.

**No self-exclusion** (deliberate deviation from the original fix ticket's note): the
renamed table's own current stores stay in the occupied set. Every introduced-name-vs-
own-store overlap is a footprint-swap rename providers cannot relocate safely
(move-ordering hazard), and no benign rename produces such an overlap — no false rejects.

**LevelDB `renameTableStores`**: plans every directory move up front (`planMove` checks
each destination's existence and throws before anything moves), then closes handles, then
moves. On reject the provider is a full no-op — handles aren't even closed, since the
pre-scan precedes the close loop. Previously the index-dir loop renamed unchecked: silent
clobber onto an empty dir on POSIX, or a raw error after the data dir had already moved.

**IndexedDB provider**: unchanged — verified it already builds the full rename list with
per-destination `hasObjectStore` checks during list construction, before any handle close
or relocation (fully no-op on reject).

## Review findings

**Process**: read the implement diff fresh (`git show 53139de4`) before the handoff
summary; read current state of `renameTable` (store-module.ts:1354-1476),
`collectOccupiedStoreNames`/`assertStoreNameFree` (180-269), LevelDB
`renameTableStores` (provider.ts:162-208), IndexedDB `renameTableStores`
(provider.ts:146-191), key-builder.ts, both test specs, and docs/store.md. A prior
review run was interrupted by an API outage after validation; its tests predated the
`store-range-seek-collation-bounds` commits that also touch quereus-store, so all
validation was re-run at current HEAD.

**Correctness — checked, no issues:**
- Guard ordering: all `assertStoreNameFree` calls precede the first side effect
  (coordinator commit, disconnect, cache evictions, provider relocation, DDL rewrite).
  A colliding rename inside a transaction also no longer force-commits the coordinator.
- Case handling: `buildDataStoreName`/`buildIndexStoreName` lowercase, so occupied-map
  keys and guard candidates are consistent; case-variant sibling names still collide
  correctly.
- Introduced names cannot collide with each other (data vs index names structurally
  differ; index names are unique per table), so single-map checking is sound.
- `currentSchema === undefined` degrades to data-store-only guarding AND data-store-only
  relocation (same `indexNames` list feeds both) — consistent, pre-existing behavior.
- LevelDB swap scenarios: because the pre-scan checks all destinations before any move,
  a destination that is also a pending source (footprint swap) is rejected — the
  provider backstop is safe standalone, not only behind the StoreModule guard.
- The sibling's-index-store collision class needs no extra guard: `{new}_idx_{x}` can
  only equal another table's *index* store if that table is named `{new}`, which the
  data-store check already rejects (analysis in the fix ticket, re-verified).

**Quality (SPP/DRY/types/cleanup) — no issues**: optional-param reuse of the occupied
map is minimal and doesn't disturb the other call sites; no `any`; no resource leaks
(reject paths leave handles untouched); comments rewritten to drop the stale
"parked backlog ticket" references.

**Tests — adequate**: primary repro, negative control, own-footprint swap (fast lane,
in-memory provider whose silently-overwriting `move` is the corruption oracle), plus the
LevelDB atomicity test asserting the directory set is unchanged on reject. Pre-existing
own-index-store rename test still passes with updated comment. Multi-index renames are
exercised only via the trivial loop — judged acceptable.

**Docs — one gap, fixed inline**: docs/store.md described the store naming convention
but never documented the collision guard (user-visible DDL rejection). Added a
"Physical name collisions" note under Store Naming Convention covering CREATE TABLE /
CREATE INDEX / RENAME rejection semantics and the provider backstop expectation.
quereus-store README's `KVStoreProvider` interface comments were already accurate.

**Major findings**: none — no new tickets filed.

**Validation at current HEAD**:
- `yarn workspace @quereus/quereus run lint`: clean.
- quereus-store suite: 412 passing; quereus-plugin-leveldb suite: 17 passing.
- Full `yarn test:store` (LevelDB-backed logic tests, the lane the handoff skipped):
  5547 passing / 13 pending / 0 failing. The prior interrupted run's single failure
  (`25-aggregate-edge-cases.sqllogic`, 30s timeout) does not reproduce — passes alone
  in ~0.4s and in the full lane — transient machine-load flake, not flagged.
- Fast lane was validated green by the prior run and by the subsequent
  store-range-seek-collation-bounds review at 21a605da, which included this code.

**Accepted residual limitations** (documented in code/handoff, unchanged by review):
- Occupancy-set blind spots: orphaned on-disk directories unknown to session tables +
  catalog are invisible to the guard; the provider pre-scan backstop fires instead
  (loud, FS-atomic, but after renameTable's in-memory evictions).
- LevelDB pre-scan TOCTOU between existence checks and renames — single-process
  assumption, same as pre-existing.
- LevelDB `storePaths` staleness on rename — pre-existing, harmless.
