description: Review the store backing host — StoreBackingHost (coordinator-pending) + StoreModule.getBackingHost + conditional IsolationModule forward, making `create materialized view … using store` work end-to-end (maintenance, cascade, covering-UNIQUE, mid-transaction visibility, rollback/savepoints, refresh, drop, collation arg). Capability + e2e suites added; all builds/tests green.
prereq: mv-noop-upsert-suppression
files:
  - packages/quereus-store/src/common/backing-host.ts               # NEW: StoreBackingHost
  - packages/quereus-store/src/common/store-table.ts                # attachCoordinator split; host-facing surface (encodeDataKey, encodePkPrefixBounds, readEffectiveRowByKey, iterateEffectiveEntries, trackPrivilegedMutation, resetStats, openDataStore)
  - packages/quereus-store/src/common/store-module.ts               # getBackingHost (ownership-guarded getOrReconnectTable resolution)
  - packages/quereus-store/src/common/index.ts                      # StoreBackingHost export
  - packages/quereus-isolation/src/isolation-module.ts              # conditional constructor-assigned getBackingHost forward
  - packages/quereus/src/core/database-materialized-views.ts        # comment-only: "always the memory module" claim fixed
  - packages/quereus-store/test/backing-host.spec.ts                # NEW: capability suite (isolated + bare flavors, DESC/NOCASE prefix)
  - packages/quereus-store/test/mv-store-backing.spec.ts            # NEW: end-to-end `using store` matrix
  - packages/quereus-store/README.md                                # backing-host section
  - packages/quereus-isolation/README.md                            # forwarding paragraph += getBackingHost
  - docs/materialized-views.md                                      # "The store host (`using store`)" subsection; stale memory-only claims fixed
  - docs/module-authoring.md                                        # inventory row (store ✓ / isolation conditional forward); reference-impl text
----

# Review: store module as MV backing host

Second step after `store-backing-host-substrate` (complete). The engine
contract (`packages/quereus/src/vtab/backing-host.ts`) was implemented, not
extended; the memory host (`MemoryBackingHost`, `vtab/memory/module.ts`) is
the reference. `create materialized view … using store` now works end-to-end
against the registered `IsolationModule(StoreModule)` wrapper and the bare
`StoreModule` alike.

## What was built

- **`StoreBackingHost`** (new, quereus-store): pending state = the per-table
  `TransactionCoordinator`. `ownsConnection` = `instanceof StoreConnection`
  + coordinator identity (destroy evicts the coordinator map ⇒ memory-parity
  incarnation pinning). `connect()` is sync (`new StoreConnection`).
  `applyMaintenance` begins an implicit coordinator txn when none is active,
  takes before-images via an effective point read per op
  (`readEffectiveRowByKey`: pending view → committed get), and queues
  coordinator ops: `delete-key` (effective lookup, delete+report iff present),
  `upsert` (**value-identical upsert suppressed** — see the amendment note
  below), `delete-by-prefix` (`encodePkPrefixBounds` → effective slice scan,
  collect-then-delete), `replace-all` (minimal keyed diff by encoded key
  bytes, value-compare per column collation, skip-identical). Stats deltas
  ride `trackPrivilegedMutation` (applied at coordinator commit).
  `replaceContents` commits an open coordinator txn FIRST (DDL-commits
  posture, `renameTable` parity), dup-checks encoded keys before any write,
  clear+rewrites in ONE provider batch, resets stats to the exact count, and
  routes through `openDataStore()` so the lazy `saveTableDDL` fires.
  `scanEffective` guards ownership EAGERLY (sync INTERNAL throw, memory
  parity), then `encodePkPrefixBounds(equalityPrefix)` +
  `iterateEffectiveEntries(bounds, reverse=descending)` — seek +
  early-terminate, never a full-store visit. NO store DataChangeEvents from
  privileged writes (cascade consumes the returned changes; sync must not
  replicate derived rows). Backing tables carry no secondary
  indexes/UNIQUEs/FKs, so only the data store is written.
- **`StoreTable`**: `ensureCoordinator` split — new sync `attachCoordinator()`
  (coordinator + stats callbacks, no connection registration). Host resolution
  calls it eagerly so the shared StoreTable's read paths (`query`,
  `iterateEffective`) merge the host's pending writes — this is what makes a
  mid-transaction `select` from the MV see pending maintenance.
  `readLiveRowByPk` refactored over the new public `readEffectiveRowByKey`.
- **`StoreModule.getBackingHost`**: resolves via `getOrReconnectTable`
  (rehydrated/rename-evicted backings resolve) behind an ownership pre-check
  (registered `vtabModule === this` OR a wrapper exposing `underlying === this`)
  so the reconnect fallback cannot adopt a foreign module's table.
- **`IsolationModule`**: `getBackingHost` is a constructor-assigned property,
  set ONLY when the underlying implements it — method presence mirrors the
  underlying (presence IS the capability). Straight delegate is correct:
  backing writes are privileged, the per-connection overlay stays empty for
  backing tables, and at commit/rollback the backing's IsolatedConnection
  no-ops while the host's StoreConnection commits/rolls back the coordinator
  (disjoint state, order-immaterial).

## Mid-flight spec amendment (important for review ordering)

While this ticket was being implemented, a parallel pass amended it: added
`prereq: mv-noop-upsert-suppression` and replaced the original
"upsert reports `update` even if byte-identical (memory parity)" wording with
the suppression contract — **a value-identical upsert (collation-aware,
against the effective row) queues no op and reports nothing**. The store host
implements the amended contract, so it is currently AHEAD of the memory host
(which still reports identical-upsert updates until `mv-noop-upsert-suppression`
lands — that ticket owns the memory backstop and the normative contract-comment
update in `vtab/backing-host.ts`). This review ticket carries the prereq so it
runs after that lands; the reviewer should then confirm the store host matches
the by-then-normative contract text and the memory host's behavior. Suppression
is sound today (nothing changed ⇒ reporting nothing is accurate; the cascade
recomputes identical rows from such a change anyway), and pinned by a
capability test.

## Divergences and store-specific semantics (documented + pinned)

- **Per-table-coordinator RYOW**: a sibling connection from `host.connect()`
  SEES pending maintenance (shared coordinator), unlike memory's
  per-connection layers. Contract-conformant (only the writing connection's
  reads-own-writes is required); pinned explicitly in the capability suite,
  documented in the host header and docs.
- **`replaceContents` commits an open coordinator txn first** — pinned by a
  refresh-in-explicit-transaction parity test that runs the identical scenario
  against a store-backed and a memory-backed MV and requires identical
  observable outcomes.
- **Backing text PK columns key under store K** (`using store(collation=…)`,
  default NOCASE): `buildBackingTableSchema` doesn't mark collations explicit,
  so `reconcilePkCollations` applies K exactly as for `create table … using
  store`. Case-variant backing keys collapse under the default (a body keyed
  solely on a case-varying text column trips "must be a set" where memory
  would accept it); `collation = 'BINARY'` gives byte-exact keys. Both arms
  pinned; documented in docs/materialized-views.md. Alternative (stamping
  `collationExplicit` on backing columns to preserve body collations exactly)
  was considered and not taken — it is an engine-side semantics change beyond
  this ticket and would diverge backing keying from store-table keying.

## Known gaps / flags for the reviewer

- **Close → reopen of a store-backed MV is NOT seamless yet** (untested here,
  deliberately): rehydrate phase 1 imports the persisted `_mv_<name>` table
  bundle as a plain table, then phase 3's re-materialize hits "Backing table
  already exists" (recorded in `RehydrationResult.errors`, non-fatal). That is
  the explicit scope of `implement/mv-adopt-fast-path` (prereq:
  store-backing-host). This ticket only guarantees its precondition — the
  `_mv_` table bundle IS in the catalog after create (pinned).
- **READONLY user-DML on backing tables remains unenforced** everywhere
  (memory included — `buildBackingTableSchema` never sets `isReadOnly`).
  Pre-existing, already filed as `backlog/backing-tables-readonly-enforcement`.
- **Ownership pre-check duck-typing**: `getBackingHost`'s wrapper check probes
  `vtabModule.underlying === this` structurally (no import of IsolationModule
  into quereus-store). Any wrapper exposing `underlying` passes; acceptable
  today, worth a look.
- **`committed.<table>` reads of a backing still see coordinator pending**
  (per-table RYOW) — pre-existing substrate posture, noted as left-as-is in
  the substrate review; unchanged here.
- **`applyMaintenance` on an unregistered connection** (capability-test usage)
  leaves an implicit coordinator txn open until rollback/commit — engine flows
  always register the connection so coordinated commit covers it; tests
  roll back explicitly.
- `yarn test:store` does not exercise the host (no `using store` MVs in logic
  tests); coverage of the host lives in the two new package suites.

## Test inventory

- `packages/quereus-store/test/backing-host.spec.ts` — the 8 memory capability
  behaviors mirrored (resolution, ownsConnection, incarnation pinning, foreign
  conn INTERNAL, RYOW + exact effective changes, equalityPrefix + descending,
  replaceContents, onDuplicateKey/no-torn-state) ×2 module flavors (isolated
  wrapper AND bare StoreModule — the bare-store smoke requirement), plus
  store-specific pins: value-identical upsert suppression, delete-by-prefix
  reporting, replace-all minimal diff/skip-identical, replaceContents
  commit-first, and a DESC + NOCASE leading-PK suite (case-variant prefix
  match, DESC key order). 26 tests.
- `packages/quereus-store/test/mv-store-backing.spec.ts` — end-to-end matrix:
  round-trip + `_mv_` catalog bundle persistence, row-time maintenance,
  mid-transaction visibility + rollback + commit lockstep, savepoint partial
  rollback, covering-UNIQUE through a store backing (mid-transaction dup,
  IGNORE/REPLACE, same-statement RYOW eviction), MV-over-MV in all three
  module directions (with per-level rollback), data-only refresh,
  refresh-in-txn memory parity, shape rebuild after source ALTER (module
  preserved), drop (backing + both catalog entries gone), and both collation
  arms. 16 tests.

## Validation (all after the final state)

- `yarn build` (root, all packages) — green.
- `yarn lint` (packages/quereus) — clean.
- `yarn test` (root, all workspaces) — green: quereus 5,719 passing /
  9 pending; quereus-store 497 passing (455 pre-existing + 42 new);
  quereus-isolation 126; all other packages passing, 0 failing.
- `yarn test:store` (LevelDB-backed engine logic tests) — 5,715 passing /
  13 pending, 0 failing.

## Use cases to verify in review

- `create materialized view mv using store as <body>` → query, write source,
  read mid-transaction, rollback, commit, savepoint-partial-rollback.
- Covering-UNIQUE: store source + `using store` covering MV; duplicate
  rejection with both rows pending; IGNORE/REPLACE; multi-row same-statement
  REPLACE.
- Chained MVs across memory/store in both directions; one base write
  propagating two levels; statement failure reverting both.
- `refresh` (plain, in-transaction, post-ALTER shape rebuild), `drop`.
- `using store(collation = 'BINARY')` vs default NOCASE keying.
