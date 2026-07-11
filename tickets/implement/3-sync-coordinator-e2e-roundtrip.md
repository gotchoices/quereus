description: Client and sync-coordinator are each tested alone, but no test drives a real sync round-trip through the coordinator — so protocol drift between them ships unnoticed. Add an end-to-end test that connects two real clients through a live coordinator and asserts a write on one arrives at the other.
prereq:
files:
  - packages/sync-coordinator/src/service/coordinator-service.ts (in-process CoordinatorService, constructed directly in service.spec)
  - packages/sync-coordinator/src/server/server.ts (HTTP + WS host)
  - packages/sync-coordinator/src/server/websocket.ts
  - packages/sync-coordinator/test/service.spec.ts (boots CoordinatorService today, but with no real WS client)
  - packages/quereus-sync-client/src/sync-client.ts (WebSocket SyncClient)
  - packages/quereus-sync-client/test/sync-client.spec.ts (client tested in isolation)
  - packages/quereus-sync/test/sync/_peer-harness.ts (real-engine peer helpers to reuse: createInMemoryProvider, makePeer, settle, localWrite)
difficulty: medium
----

## Goal

One end-to-end integration test that drives a **real sync round-trip through the
`sync-coordinator` WebSocket server**: boot the coordinator, connect two
`SyncClient`s backed by real Quereus engines, write on client A, and assert the
row lands on client B — the check that catches client/coordinator protocol skew
(the codecs have already drifted once; see the sync-protocol work in
`tickets/complete/`).

Today `sync-coordinator/test/service.spec.ts` constructs `CoordinatorService`
directly and pokes it in-process (no WebSocket, no client), and
`quereus-sync-client/test/sync-client.spec.ts` exercises the client against a stub.
Nothing wires the two across the wire. This ticket adds exactly that wiring test.

## Design

- Boot the coordinator's **HTTP + WebSocket server** (`server/server.ts`) on an
  **ephemeral port** (port `0`, read back the assigned port) so parallel test runs
  never collide. Back it with an in-memory / tmpdir store as `service.spec.ts`
  already does (`CoordinatorService` + `DEFAULT_CONFIG`, tmpdir batch store).
- Stand up **two `SyncClient`s** over `ws://127.0.0.1:<port>`, each backed by a real
  `Database` engine (reuse `createInMemoryProvider` / `makePeer` from
  `_peer-harness.ts` for the engine side; the client is the new piece).
- Round-trip: `localWrite` a row on A → let the client push to the coordinator →
  coordinator relays to B → poll/`settle` until B's engine shows the row →
  assert full row fidelity (all columns, not just the key).
- Cover the **bidirectional** case too (write on B, observe on A) so a
  one-directional codec bug can't pass.

Where the test lives: prefer `packages/sync-coordinator/test/` (the coordinator is
the subject under test and already depends on client-facing types). If that creates
a dependency cycle (coordinator → sync-client), put it in a neutral spot — but do
**not** duplicate the peer harness; import it.

## Edge cases & interactions

- **Async settle / no fixed sleep**: assert by polling the target engine until the
  expected state (with a bounded timeout), not a bare `setTimeout`. A flaky fixed
  delay is worse than no test. Reuse the harness `settle` idiom.
- **Connection teardown**: every test must `disconnect()` both clients, `close()`
  both engines, and stop the WS server + `CoordinatorService` in `afterEach`, even
  on failure — a leaked WS listener wedges later specs. Mirror `service.spec.ts`
  tmpdir cleanup (`rm` the batch-store dir).
- **Reconnection noise**: `SyncClient` auto-reconnects with backoff. On teardown set
  the intentional-disconnect path so a closing socket doesn't spawn reconnect timers
  that fire after the test ends (see `intentionalDisconnect` / `stopReconnect` in
  `sync-client.ts`).
- **Auth/token path**: `CoordinatorService` supports hooks/token gating
  (`service.spec.ts` exercises denied + token services). Pick the open/no-auth config
  for the happy-path round-trip; a denied-handshake assertion is a nice-to-have, not
  required for this ticket.
- **Empty / already-exists DDL**: the relay path re-applies schema; the harness
  already tolerates "table already exists" — make sure the two engines start from the
  same DDL so bootstrap doesn't fight the first change.
- **Watermark / batching**: the client debounces local changes and promotes
  watermarks. Ensure the assertion waits long enough for a debounced batch to flush,
  or drive the flush explicitly if the client exposes it.

## TODO

- Add a helper to boot coordinator HTTP+WS on an ephemeral port and return
  `{ url, stop() }`; back it with the tmpdir store pattern from `service.spec.ts`.
- Write `sync-coordinator-roundtrip.e2e.spec.ts`: two real-engine `SyncClient`s
  through the live coordinator; assert A→B row fidelity, then B→A.
- Wire deterministic teardown (disconnect clients, close engines, stop server,
  rm tmpdir) in `afterEach`.
- Run the coordinator suite (`yarn workspace @quereus/sync-coordinator test`) and the
  client suite; confirm green and no leaked-handle hang at exit.
