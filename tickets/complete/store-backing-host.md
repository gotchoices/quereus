----
description: Store module as MV backing host — StoreBackingHost (coordinator-pending) + StoreModule.getBackingHost + conditional IsolationModule forward, making `create materialized view … using store` work end-to-end (maintenance, cascade, covering-UNIQUE, mid-transaction visibility, rollback/savepoints, refresh, drop, collation arg). Reviewed and complete.
files:
  - packages/quereus-store/src/common/backing-host.ts
  - packages/quereus-store/src/common/store-table.ts
  - packages/quereus-store/src/common/store-module.ts
  - packages/quereus-store/src/common/index.ts
  - packages/quereus-isolation/src/isolation-module.ts
  - packages/quereus/src/core/database-materialized-views.ts
  - packages/quereus-store/test/backing-host.spec.ts
  - packages/quereus-store/test/mv-store-backing.spec.ts
  - packages/quereus-store/README.md
  - packages/quereus-isolation/README.md
  - docs/materialized-views.md
  - docs/module-authoring.md
----

# Complete: store module as MV backing host

Second step after `store-backing-host-substrate`. The engine contract
(`packages/quereus/src/vtab/backing-host.ts`) was implemented over a
(StoreTable, TransactionCoordinator) pair; `create materialized view … using
store` works end-to-end against both the registered
`IsolationModule(StoreModule)` wrapper and the bare `StoreModule`.

## What was built (implement stage, commit 182c0cc8)

- **`StoreBackingHost`** (new): pending state = the per-table
  `TransactionCoordinator` (per-table-coordinator RYOW — documented divergence
  from memory's per-connection layers, contract-conformant). `ownsConnection`
  = `instanceof StoreConnection` + coordinator identity (destroy evicts the
  coordinator map ⇒ incarnation pinning). Sync `connect()`. `applyMaintenance`
  begins an implicit coordinator txn when needed, takes before-images via
  effective point reads, queues `delete-key` / `upsert` (value-identical
  suppression per the now-normative contract) / `delete-by-prefix` (encoded
  prefix-bounds slice scan) / `replace-all` (minimal keyed diff by encoded key
  bytes). Stats deltas ride `trackPrivilegedMutation`. `replaceContents`
  commits an open coordinator txn first (DDL-commits posture), dup-checks
  before any write, clear+rewrites in one provider batch, resets stats
  exactly. `scanEffective` guards ownership eagerly, seek + early-terminate
  prefix scan, never a full-store visit. No store DataChangeEvents from
  privileged writes.
- **`StoreTable`**: `ensureCoordinator` split into sync `attachCoordinator()`
  (host resolution attaches eagerly so shared read paths merge host pending —
  mid-transaction MV reads). New narrow host surface: `encodeDataKey`,
  `encodePkPrefixBounds`, `readEffectiveRowByKey`, `iterateEffectiveEntries`,
  `trackPrivilegedMutation`, `resetStats`, `openDataStore`.
- **`StoreModule.getBackingHost`**: resolves via `getOrReconnectTable` behind
  an ownership pre-check (registered `vtabModule === this` OR wrapper exposing
  `underlying === this`).
- **`IsolationModule`**: `getBackingHost` constructor-assigned only when the
  underlying implements it (presence IS the capability); straight delegate is
  correct because backing writes are privileged and bypass the overlay.
- Tests: capability suite ×2 module flavors + DESC/NOCASE suite (29 tests),
  end-to-end `using store` matrix (16 tests). Docs: materialized-views.md
  store-host subsection, module-authoring inventory row, both package READMEs.

## Review findings

**Process.** Read the implement diff (182c0cc8) fresh before the handoff
summary; read the engine contract, the memory reference (`MemoryBackingHost`,
`applyMaintenanceToLayer`, `replaceBaseLayer`), `TransactionCoordinator`,
`StoreConnection`, `iterateEffective`, `buildPkPrefixBounds`,
`getOrReconnectTable`, `renameTable`, `resolveBackingHost`, and both new test
suites; cross-checked the post-implement reconciliation from
`mv-noop-upsert-suppression` (which amended this code after the implement
commit). Ran one empirical probe beyond the suites (below).

**Checked and sound (no action):**

- *Contract conformance*: all five `BackingHost` methods match the engine
  contract, including the value-identical upsert suppression that became
  normative after `mv-noop-upsert-suppression` landed — the store host's
  byte-faithful `rowsValueIdentical` point-op skip vs collation-aware
  `replace-all` skip exactly mirrors the contract text and the memory host;
  pinned by the DESC/NOCASE "collation-equal / byte-different upsert is NOT
  suppressed" test.
- *Coordinator addressing*: host puts/deletes use the default-store bucket (no
  store argument), the same bucket all store read paths merge — honors the
  coordinator's documented bucket contract for lazily-constructed defaults.
- *Merge/scan correctness*: `iterateEffective`'s two-way merge handles reverse
  (sign-folded comparison, puts reversed), bounds-filters pending puts, and
  `getOrderedPendingOps` returns a stable snapshot so collect-then-delete and
  the replace-all diff can't tear. Prefix bounds slice `pkDirections` /
  `pkKeyCollations` to prefix length correctly; key-builder property tests
  already pin DESC/NOCASE/escape-byte exactness.
- *Stats discipline*: ±1 only on effective transitions, buffered via
  `trackMutation(delta, true)` and applied/discarded by the
  attach-time-registered commit/rollback callbacks; `resetStats` after
  `replaceContents` replaces drift with the exact count.
- *Eager ownership guard parity*: `scanEffective` asserts ownership before
  returning the generator (sync INTERNAL throw), pinned without iteration.
- *Incarnation pinning*: destroy evicts both module maps; pinned by the
  drop+recreate test in both module flavors.
- *Isolation forward*: presence-mirroring via constructor assignment is
  correct, and the privileged-bypass reasoning holds (backing overlay stays
  empty; commit/rollback ordering immaterial across disjoint state).
- *Engine resolution path*: `resolveBackingHost` calls the registered module
  (the wrapper), so the conditional forward is exactly what `using store`
  needs; create-fill, refresh fast path, and shape rebuild all route through
  `replaceContents` with the "must be a set" factory.
- *Docs*: read every touched doc plus the post-landing reconciliation —
  the implement commit's "future extensions" suppression bullet was properly
  removed when `mv-noop-upsert-suppression` landed; no stale claims found.

**Found — major, filed as `fix/store-ddl-commit-savepoint-stack`:**
`replaceContents`' commit-first posture clears the coordinator's savepoint
stack; a later `rollback to <savepoint>` on the still-registered backing
connection throws "Savepoint depth 0 not found" (NOTFOUND), where the memory
arm warns and continues (final post-commit states converge). Reproduced with
a scratch probe (refresh-inside-savepoint, store vs memory arms; probe
deleted, repro recorded in the fix ticket). NOT introduced by this ticket —
`renameTable` has taken the identical posture all along, so this is a
pre-existing store-wide DDL-commits × savepoint interaction; the host widens
exposure (refresh-in-savepoint is more plausible than rename-in-savepoint).
Not fixed inline because the right behavior (warn-and-return parity vs
re-seeding the stack vs rejecting DDL in savepoints) is a semantics decision
beyond a review pass.

**Checked — accepted as-is (with reasons):**

- *Duck-typed wrapper ownership check* (`vtabModule.underlying === this`):
  any wrapper exposing `underlying` passes. Accepted — quereus-store does
  depend on @quereus/isolation, so an `instanceof` check was possible, but the
  structural probe keeps `getBackingHost` wrapper-agnostic, and a wrapper
  exposing `underlying` is doing so deliberately; the reconnect fallback it
  guards still requires the table to be registered in the schema manager.
- *`replace-all` with duplicate keys among `rows`* silently last-write-wins
  and reports duplicate inserts (cascade over-report + store stats drift of
  +1/dup). Exact memory parity (memory's arm has no dup check either) — an
  engine-contract question shared by both hosts, predating this ticket; the
  set gate fires at create-fill/refresh via `replaceContents`. Not filed: the
  point-op arms share the same engine-level posture and the substrate review
  already shipped it.
- *`applyMaintenance` on an unregistered connection* leaves an implicit
  coordinator txn open — engine flows always register; capability tests roll
  back explicitly.
- *Close→reopen of a store-backed MV not seamless* — explicit scope of
  `implement/mv-adopt-fast-path` (exists, verified); the precondition this
  ticket guarantees (the `_mv_` table bundle in the catalog after create) is
  pinned.
- *READONLY user-DML on backing tables unenforced* — pre-existing, both hosts;
  `backlog/backing-tables-readonly-enforcement` (exists, verified).

**Minor fixes applied in this pass:** none required — no code defects found at
review level; the one behavioral finding was major (filed above).

## Validation (review pass, after deleting the scratch probe)

- `yarn build` (root, all packages) — green.
- `yarn lint` (packages/quereus) — clean.
- `yarn test` (root, all workspaces) — 0 failing: quereus 5,775 passing /
  9 pending; quereus-store 498; quereus-isolation 126; all others green.
- `yarn test:store` — 5,771 passing / 13 pending, 0 failing.
