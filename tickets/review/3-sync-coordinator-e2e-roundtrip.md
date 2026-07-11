description: A new end-to-end test connects two real sync clients through a live coordinator server and checks that a write on one client shows up on the other, so protocol mismatches between client and coordinator get caught.
prereq:
files:
  - packages/sync-coordinator/test/sync-coordinator-roundtrip.e2e.spec.ts (NEW — the round-trip spec)
  - packages/sync-coordinator/test/_e2e-harness.ts (NEW — boots coordinator on ephemeral port + builds real-engine client peers)
  - packages/sync-coordinator/package.json (added @quereus/sync-client devDependency)
  - packages/sync-coordinator/src/service/coordinator-service.ts (broadcastChanges — the A→B relay path)
  - packages/sync-coordinator/src/server/websocket.ts (wire handlers under test)
  - packages/quereus-sync-client/src/sync-client.ts (the client under test)
difficulty: medium
----

## What was built

One new integration spec plus a small harness, in `packages/sync-coordinator/test/`:

- **`_e2e-harness.ts`**
  - `bootCoordinator()` — starts the real coordinator HTTP+WebSocket server
    (`createCoordinatorServer`) on **port 0** (OS-assigned ephemeral port, read
    back from `server.app.server.address()`), backed by a tmpdir LevelDB store
    like `service.spec.ts`. Returns `{ server, url, dataDir, stop() }`; `stop()`
    shuts the server+service down and removes the tmpdir.
  - `makeClientPeer(ddl)` — builds a real `Database` engine with a store-backed
    table and a sync module that captures its local transactions, using the
    **published** `@quereus/sync` / `@quereus/store` / `@quereus/quereus` APIs
    (`createSyncModule` + `createStoreAdapter`). Returns `{ db, syncManager,
    syncEvents, close() }`. The `syncEvents` returned is the SAME emitter the
    sync module records local changes on — it is handed to the `SyncClient` so
    its local-change subscription actually fires.
  - `collect`, `waitFor` (bounded polling — no fixed sleeps), `tick`.

- **`sync-coordinator-roundtrip.e2e.spec.ts`** — boots the coordinator, connects
  two real-engine `SyncClient`s over `ws://127.0.0.1:<port>/sync/ws`, and asserts:
  1. **A→B** — insert on A's engine arrives on B's engine (row fidelity: `note`
     text + `qty` int, not just the key).
  2. **B→A** — the reverse (so a one-directional codec bug can't pass).
  3. **cross-replication** — concurrent writes on both, each lands on the other.

The only path from peer A's engine to peer B's engine is through the coordinator
WebSocket (separate providers, separate KV stores), so this genuinely exercises
`SyncClient` → `apply_changes` → `CoordinatorService.applyChanges` →
`broadcastChanges` (`push_changes`) → `SyncClient.handleChanges` → store.

## How to run / validate

- `yarn workspace @quereus/sync-coordinator test` → **116 passing** (113 prior +
  3 new), clean exit, no leaked-handle hang.
- `yarn workspace @quereus/sync-client test` → **52 passing** (unchanged).
- The spec is real: `waitFor` throws on timeout (→ test fails) if the row never
  arrives, and the value assertions fail on any codec skew. It is not a
  pass-by-construction test.

## Key design decisions (worth a reviewer's eye)

- **Dist, not source, for the client-side engine.** The harness builds the peer
  engine from the *published* `@quereus/sync` API rather than importing
  `packages/quereus-sync/test/sync/_peer-harness.ts` (which the ticket suggested
  reusing). Two reasons: (a) the coordinator and `@quereus/sync-client` both
  resolve `@quereus/sync` to its **dist**; importing the source harness would
  load a SECOND copy of the wire codec — the very thing a drift test must keep
  singular; (b) that harness lives outside the coordinator package's
  `tsconfig.test.json` `rootDir`, which ts-node type-checks. Trade-off: a little
  peer-wiring code is re-expressed here instead of imported. If a future change
  wants true single-sourcing, the cleanest move is to export a
  dist-API peer factory from `@quereus/sync` itself and have both harnesses call it.

- **Schema is pre-seeded before sync capture is wired.** `makeClientPeer` runs
  the `create table` DDL *before* `createSyncModule` subscribes to commits, so
  the bootstrap schema is never captured or replicated. Both peers still start
  from the same schema; only post-setup writes sync. See the next section for
  why this matters.

## Known gaps / observations for the reviewer (treat tests as a floor)

- **`create_table` replication is not idempotent — flag, not fixed here.** My
  first green run (both peers independently running the same DDL *after* capture
  was wired) spammed `Error handling sync message: ... Table main.orders already
  exists` on every connect: each peer's `create_table` migration replicates to a
  peer that already has the table, and the store adapter
  (`store-adapter.js applySchemaChange`) throws instead of tolerating it. The
  data round-trip still passed (inserts arrive via the separate `push_changes`
  broadcast), but this is a real, reachable scenario in offline-first (two
  devices each run migrations, then connect). Open question the reviewer should
  weigh: when a `get_changes` reply batches a `create_table` changeset *and* a
  DML changeset into one `applyChanges` call, does the create_table throw abort
  the whole batch and drop the co-batched DML? If so that is a genuine
  `bug-`/`debt-` candidate in `@quereus/sync`, not the coordinator. I sidestepped
  it in the harness (pre-seed before capture) rather than paper over it; it is
  **out of scope for this ticket** but should not be lost.

- **Debounce/settle timing.** The spec uses `localChangeDebounceMs: 10`, a 50 ms
  post-connect settle before the first write (so the client's local-change
  subscription is live), and `waitFor` with a 3 s bound / 25 ms poll. These are
  generous for in-memory engines on a loaded CI box, but if this ever flakes
  under heavy parallelism the bound is the first knob. No fixed `setTimeout`
  gates a correctness assertion — only the settle-before-write, which is a
  liveness guard, not a data assertion.

- **Happy path / open auth only.** Uses `auth.mode: 'none'` (per the ticket).
  A denied-handshake round-trip and a reconnect-mid-stream round-trip are
  reasonable follow-ups but were explicitly out of scope.

- **No multi-row / update / delete fidelity.** Only single-row inserts are
  asserted. `update`/`delete`/multi-column-update replication across the wire is
  untested here and a natural next layer.

- **Coordinator relays without a local basis table.** The coordinator is
  relay-only (no `getTableSchema`), so unknown-table detection is inert and it
  relays `orders` changes with no local `orders` table — confirmed working, but
  worth knowing when reading the flow.
