description: Design the store module (quereus-store) as a materialized-view backing host — implement the BackingHost capability over StoreTable, decide the catalog-persistence treatment of `_mv_` tables, and realize the durable-backing rehydrate adopt fast path (reopen without body re-fill) under the gates decided in the pluggability plan.
prereq: mv-backing-using-module
files:
  - packages/quereus/src/vtab/backing-host.ts                        # the capability contract to implement
  - packages/quereus-store/src/common/store-module.ts                # getBackingHost + rehydrate phasing
  - packages/quereus-store/src/common/store-table.ts                 # privileged write/scan over the isolation overlay
  - packages/quereus/src/schema/manager.ts                           # importMaterializedView adopt fast path seam
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts   # materializeView adopt-vs-refill arm
  - docs/materialized-views.md                                       # durable-backing rehydrate semantics
----

# Store module as MV backing host + durable-backing adopt fast path

Follow-on to `mv-backing-using-module`: the in-repo durable proof of the
backing-host capability, and the stated use case "store-module-backed MVs that
survive reopen without a full body re-fill". Needs its own research pass into
quereus-store / quereus-isolation internals before implement tickets can be
cut.

## Decisions already taken (by the pluggability plan — design against these)

- **Capability contract is fixed** (`vtab/backing-host.ts`): PK-ordered
  storage, O(log n) keyed ops, ordered prefix-range scan, effective-change
  reporting, reads-own-writes pending state, coordinated-commit connection.
  The store either satisfies it or does not advertise it — no per-arm gating.
- **Cross-module atomicity**: coordinated commit accepted as-is; the crash
  window between two durable modules' commits is documented, healed by
  rehydrate refill.
- **Adopt fast path gates** (trust the durable backing at reopen, skip the
  body re-fill) — adopt iff ALL of:
  1. a table already exists at the backing name in the MV's declared backing
     module,
  2. its shape structurally matches the derived `BackingShape`
     (`backingShapeMatches`),
  3. the imported entry's recomputed `bodyHash` matches the persisted MV
     record's (automatic when the DDL is the hash source — verify),
  4. **every source table resolves to the SAME module as the backing** — the
     same-module gate that makes trusted rows sound (one durability domain,
     one commit; a cross-module backing is always refilled so crash divergence
     self-heals).
  Anything else ⇒ today's drop + refill.

## To research / design

- **Privileged write surface over the isolation overlay**: how
  `applyMaintenance` writes the store connection's pending transaction state
  bypassing user-DML read-only, while keeping the store's secondary-index
  bookkeeping and savepoint replay correct (quereus-isolation snapshot layer).
  Decide whether `replaceContents` maps to a bulk batch swap or keyed rewrite.
- **Effective-change reporting**: the store must return realized
  insert/update/delete with before-images; assess whether its write path
  already knows the before-image or needs a point read per op, and the cost.
- **Prefix scan**: confirm the store's key encoding supports the
  leading-PK-equality seek + early-terminate contract (collation-aware PK key
  encoding exists — `pkKeyCollations`).
- **Catalog persistence of `_mv_` tables**: createBackingTable fires
  `table_added` for the backing; decide whether the store persists it as a
  table catalog entry (enabling phase-1 rehydrate + adopt) or suppresses the
  reserved prefix and recreates at MV import. The adopt fast path wants the
  former; reconcile with the import-time pre-existing-backing handling that
  `mv-backing-using-module` adds (same-module ⇒ replace; adopt upgrades that
  arm to gate-checked trust).
- **Same-store-commit atomicity**: verify source-table writes and backing
  writes within one transaction land in ONE store commit (or design the
  batch-join so they do) — this is what justifies adopt gate (4).
- **Where the adopt arm lives**: `materializeView` (shared core) vs an
  import-only seam in `importMaterializedView`; create (user DDL) never adopts.

## Expected outputs

Implement ticket(s) sized to one run each — likely (a) store BackingHost
implementation + capability tests against the engine suite, (b) adopt fast
path + reopen tests (reopen without refill asserted by instrumenting the body
read; stale-gate fallbacks asserted by perturbing shape/hash/module). Key
tests: store-backed MV round-trip with maintenance before and after reopen;
covering-UNIQUE enforcement through a store backing; MV-over-MV with mixed
memory/store levels; crash-window simulation (divergent backing) healed by the
refill path when any adopt gate fails.
