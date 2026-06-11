description: Implement the BackingHost capability on StoreModule (coordinator-pending based) with conditional forwarding through IsolationModule, making `create materialized view … using store` work end-to-end — maintenance, cascade, covering-UNIQUE, mid-transaction visibility, rollback/savepoints — with capability-surface tests mirroring the memory host's.
prereq: store-backing-host-substrate
files:
  - packages/quereus/src/vtab/backing-host.ts                       # the fixed contract (read-only)
  - packages/quereus/test/vtab/backing-host.spec.ts                 # the memory capability tests to mirror
  - packages/quereus-store/src/common/backing-host.ts               # NEW: StoreBackingHost
  - packages/quereus-store/src/common/store-module.ts               # getBackingHost
  - packages/quereus-store/src/common/store-table.ts                # host access to store/coordinator/pk encoding
  - packages/quereus-isolation/src/isolation-module.ts              # conditional getBackingHost forward
  - packages/quereus-store/test/backing-host.spec.ts                # NEW: capability-surface tests
  - packages/quereus-store/test/mv-store-backing.spec.ts            # NEW: end-to-end `using store` MV tests
  - docs/materialized-views.md                                      # substrate section: store host realized
  - docs/module-authoring.md                                        # Backing Host inventory rows (store / isolation)
----

# Store module as MV backing host

Second step (after `store-backing-host-substrate`). The contract in
`vtab/backing-host.ts` is FIXED — implement it, don't extend it. The memory
host (`MemoryBackingHost` in `packages/quereus/src/vtab/memory/module.ts`) is
the reference; `packages/quereus/test/vtab/backing-host.spec.ts` pins the
behaviors a second host must reproduce.

## Design (resolved by the plan pass)

**Pending state = the per-table TransactionCoordinator**, not the isolation
overlay. The registered `'store'` module is `IsolationModule(StoreModule)`
(`createIsolatedStoreModule`), but all backing writes are privileged, so the
backing's per-connection overlay stays empty; the host lives on `StoreModule`
and `IsolationModule` forwards it. Mid-transaction user reads of the MV reach
the pending maintenance through the substrate ticket's reads-own-writes merge
(IsolatedTable merged read → empty overlay → `StoreTable.query` → pending
merge). Commit/rollback split cleanly across the two registered connections:
the backing's IsolatedConnection (reads) flushes a no-op empty overlay; the
host's StoreConnection commits/rolls back the coordinator. The two touch
disjoint state, so ordering between them is immaterial.

### StoreBackingHost (new file in quereus-store)

One instance per (StoreTable, coordinator) pair = one backing-table
incarnation (`StoreModule.destroy` evicts both maps; a drop+recreate yields
fresh ones, so identity comparison gives memory-parity incarnation pinning).

- `ownsConnection(conn)` — `conn instanceof StoreConnection && conn.getCoordinator() === <this coordinator>`.
- `connect()` — `new StoreConnection(tableName, coordinator)` (sync; the
  substrate ticket made the coordinator synchronously constructible). The
  caller registers it; `Database.registerConnection`'s savepoint-stack replay
  drives `createSavepoint` onto the coordinator.
- `applyMaintenance(conn, ops)` — privileged writes into the coordinator's
  pending state (begin implicitly if needed, matching memory's lazy
  transaction layer), returning EFFECTIVE `BackingRowChange`s:
  - before-images via an effective point read (pending view → committed
    `store.get`) per op — one O(log n) read per point op (the design accepted
    this cost; the store's write path doesn't otherwise know the image);
  - `upsert` → put; report `update` when an effective row existed (even if
    byte-identical — memory parity), else `insert`;
  - `delete-key` → effective lookup; present ⇒ delete + report `delete`, else
    nothing;
  - `delete-by-prefix` → `buildPkPrefixBounds` + `iterateEffective`; delete +
    report per matched row;
  - `replace-all` → enumerate effective contents, minimal keyed diff against
    the new rows by encoded data key, value-compare per column under the
    column's collation (mirror `applyMaintenanceToLayer`'s skip-identical),
    queue ops, report the diff.
  - Backing tables carry **no secondary indexes / uniqueConstraints / FKs**
    (`buildBackingTableSchema` builds none) — the host writes the data store
    only; assert/comment that invariant rather than maintaining index stores.
  - Track stats deltas (`trackMutation(delta, true)`) so `estimatedRows`
    stays useful.
  - Do **not** emit store DataChangeEvents from privileged writes: the
    cascade consumes the returned changes, and the sync layer must not
    replicate derived rows. Document in the host header.
- `replaceContents(rows, onDuplicateKey?)` — committed bulk replace:
  1. If the coordinator is in a transaction, **commit it first** (memory's
     `replaceBaseLayer` drains in-flight layers the same way; `renameTable`
     already takes this DDL-commits-buffered-writes posture).
  2. Detect duplicate encoded data keys among `rows` BEFORE writing; throw
     `onDuplicateKey()` (or generic CONSTRAINT) with no torn state.
  3. Clear + rewrite the data store in batches; reset stats to `rows.length`
     and flush.
  4. Route through `StoreTable.ensureStore()` so the lazy `saveTableDDL`
     fires — this catalog write IS the phase-1 rehydrate candidate the adopt
     ticket depends on.
- `scanEffective(conn, { equalityPrefix, descending })` —
  `buildPkPrefixBounds(equalityPrefix, …, pkDirections, pkKeyCollations)` +
  `iterateEffective(bounds, reverse: descending)`. Seek + early-terminate via
  the byte bounds satisfies the O(log n) prefix-scan cost contract (no
  full-store visit).

### Module wiring

- `StoreModule.getBackingHost(db, schemaName, tableName)` — resolve via
  `getOrReconnectTable` (a rehydrated-but-untouched backing must resolve);
  return a host bound to the CURRENT table+coordinator. Resolved fresh per
  engine call (engine never caches hosts), so incarnation identity holds.
- `IsolationModule` — forward conditionally so METHOD PRESENCE mirrors the
  underlying (presence is the capability): assign `this.getBackingHost` in the
  constructor only when `underlying.getBackingHost` exists. A wrapper around a
  capability-less module must NOT advertise. `buildBackingTableSchema`'s gate
  and `resolveBackingHost` then work unchanged against the registered wrapper.

## Edge cases & interactions

- **Two connections at commit/rollback** — a SELECT of the MV registers an
  IsolatedConnection for the backing; maintenance registers the host's
  StoreConnection. Commit order between them is arbitrary; rollback must
  discard coordinator pending (StoreConnection.rollback) while the
  IsolatedConnection's overlay clear is a no-op. Pin with explicit tests
  (write + read MV + rollback; write + read + commit).
- **Incarnation pinning** — refresh's shape rebuild (`rebuildBackingTable`)
  drops + recreates the backing through the wrapper: `IsolationModule.destroy`
  must evict its `underlyingTables` entry (it does) and `StoreModule.destroy`
  its table/store/coordinator entries (it does). New host must reject the old
  incarnation's StoreConnection (`ownsConnection` false) — test like the
  memory suite's pinning test.
- **`replaceContents` inside an explicit transaction** (refresh-in-txn after
  source writes): the commit-first posture makes the refresh effectively
  DDL-committing, matching memory's drain. Assert parity: same observable
  behavior as memory for `begin; insert source; refresh mv; rollback`.
- **Covering-UNIQUE through a store backing** — `findUniqueConflictViaCoveringMv`
  in `store-table.ts` routes through `db._lookupCoveringConflicts` → host
  `scanEffective`; its doc comment still says the backing is "always the
  memory module" — update. Test: store source + covering row-time MV
  `using store`, duplicate insert rejected mid-transaction (pending source row
  + pending backing row), IGNORE/REPLACE arms.
- **MV-over-MV mixed levels** — cascade routes returned changes into consumer
  MVs: test memory-over-store, store-over-memory, store-over-store (write to
  base source propagates two levels; rollback reverts both).
- **`delete-by-prefix` under DESC / NOCASE leading PK** — prefix encoding must
  use the backing's `pkKeyCollations`/`pkDirections`; a case-variant prefix
  value must match under NOCASE.
- **Savepoints** — partial rollback of a multi-statement transaction truncates
  backing maintenance in lockstep with the source overlay (test: insert,
  savepoint, insert, rollback-to, commit ⇒ MV reflects only the first row).
- **Bare StoreModule registration** (no isolation) also advertises the host —
  contract-conformant thanks to substrate RYOW; one smoke test (capability
  tests can run against bare store where the isolation wrapper is irrelevant).
- **`using store(...)` args** — backing vtabArgs flow from the MV clause
  (`canonicalBackingModuleArgs`); the store's `collation` arg affects PK key
  encoding (K default NOCASE). One test with `using store(collation = 'BINARY')`
  asserting key behavior (case-distinct PK values survive).
- **table_added persistence** — the store's schema-change listener ignores
  `table_added`; the `_mv_` catalog entry lands via the lazy first-access
  `saveTableDDL` (replaceContents path above). Verify the catalog holds the
  `_mv_` table bundle after create (the adopt ticket's precondition).

## Tests

- `packages/quereus-store/test/backing-host.spec.ts` — mirror the 8 memory
  capability tests (resolution, ownsConnection, incarnation pinning, foreign
  connection INTERNAL, reads-own-writes + exact effective changes,
  equalityPrefix + descending, replaceContents + onDuplicateKey/no-torn-state)
  against `createIsolatedStoreModule({ provider: <InMemoryKVStore provider> })`.
- `packages/quereus-store/test/mv-store-backing.spec.ts` — the end-to-end
  matrix above (round-trip, mid-transaction visibility, rollback, savepoints,
  covering-UNIQUE, MV-over-MV, refresh, drop).
- `yarn build`, `yarn lint` (quereus), `yarn test`; run `yarn test:store` once
  (this work is store-specific by definition).

## TODO

- StoreBackingHost implementation + StoreModule.getBackingHost
- IsolationModule conditional forward (constructor-assigned)
- findUniqueConflictViaCoveringMv comment fix; host header docs (no events, no
  secondary indexes invariant)
- Capability-surface spec + end-to-end MV spec
- docs/materialized-views.md + docs/module-authoring.md inventory updates
- Build/lint/test + test:store
