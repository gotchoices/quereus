description: Fixed a bug where one temporary server error would permanently disable the sync client's automatic reconnection; reviewed and confirmed correct.
files:
  - packages/quereus-sync-client/src/sync-client.ts
  - packages/quereus-sync-client/src/types.ts
  - packages/sync-coordinator/src/server/websocket.ts
  - packages/quereus-sync-client/test/sync-client.spec.ts
  - packages/sync-coordinator/test/websocket.spec.ts
  - docs/sync.md
----

## Summary

A server `error` message used to set `intentionalDisconnect = true` on **any** error,
and `scheduleReconnect()` early-returns whenever that flag is set (reset only in
`connect()`). Result: one transient per-request error (e.g. `APPLY_CHANGES_ERROR`)
permanently killed auto-reconnect for the process lifetime.

Fix separates two concerns:
- `intentionalDisconnect` — set **only** when the client calls `disconnect()`.
- `stopReconnect` — set **only** by a fatal server error.

Both reset in `connect()`; `scheduleReconnect` bails on either. A new
`handleServerError()` decides fatal vs transient via `message.fatal ?? FATAL_ERROR_CODES.has(code)`
(server authoritative, built-in fallback set for legacy coordinators). Transient errors
keep the connection and its auto-reconnect intact; fatal errors stop reconnect and set a
lasting `error` status. Coordinator's `sendError()` now emits a `fatal` boolean —
`true` on the three fatal sends, `false` (default) on the six per-request ones.

Folded-in hardening (cohesive with reconnect): `connect()`/`disconnect()` detach a dead
socket's handlers before closing so its deferred `onclose` can't schedule a competing
reconnect; `send()` returns `boolean` and `pushLocalChanges` advances the delta-sync
watermark only when the send actually left the socket.

## Review findings

**Verdict: implementation accepted as-is. No inline fixes, no new tickets.**

Checked from every angle; what was examined and found:

- **Core reconnect correctness** — the two-flag split is sound. Traced fatal path
  (`stopReconnect=true`, status `error`, socket closes → `onclose` sees `wasError` →
  skips `disconnected`, `scheduleReconnect` bails) and transient path (both flags stay
  `false`, socket stays open, a later drop reconnects). Both correct. **No defect.**

- **Coordinator wire contract** — audited all nine `sendError` callsites in
  `websocket.ts`. Exactly the three fatal codes (`AUTH_FAILED`, `MISSING_DATABASE_ID`,
  `ALREADY_AUTHENTICATED`) pass `fatal:true`; the six transient ones
  (`NOT_AUTHENTICATED`, `UNKNOWN_MESSAGE`, `MESSAGE_ERROR`, `GET_CHANGES_ERROR`,
  `APPLY_CHANGES_ERROR`, `SNAPSHOT_ERROR`) default to `false`. No transient error also
  closes the socket. Client's `FATAL_ERROR_CODES` fallback set matches the three fatal
  codes. **Consistent.**

- **Stale-socket detach** — verified genuinely tested, not a false pass. `MockWebSocket`
  `close()` and `simulateClose()` both null-guard `onclose`; `connect()` detaches
  handlers *before* `close()`, so the deferred fire is a no-op. **Correct.**

- **Send-failure / watermark** — confirmed `pushLocalChanges` leaves `pendingSentHLC`
  and the pending count untouched on a dropped send, so unsent changes are retried on the
  next push (or after reconnect via `handshake_ack`). Test drives a throwing `ws.send`
  and asserts the watermark stays null and the failure surfaces. **Correct.**

- **Docs** — read `docs/sync.md` fatal-vs-transient section against the code; it matches
  the shipped behavior (two flags, code lists, legacy fallback). **Up to date.**

- **Tests** — `@quereus/sync-client` 54 passing, `@quereus/sync-coordinator` 125 passing,
  `sync-client` tsc build clean (exit 0). The `socket write failed` / `Unknown sync
  message type` lines in test output are the deliberately-triggered logs from the
  send-failure and unknown-type tests, not real failures.

**Minor / conditional (note-only, no ticket, no fix):**

- **`pendingLocalChangeCount` is dead state** — written (incremented on local change,
  cleared on successful push) but read nowhere. Pre-existing; this ticket only added the
  early-return guarding its clear. Not introduced here, not in scope; flagged so a future
  cleanup can drop it.
- **`ALREADY_AUTHENTICATED` sends `fatal:true` but the coordinator does not close the
  socket** (unlike the other two fatal sends). Client ends up `stopReconnect=true` /
  status `error` with an open socket. This is the degenerate "client sent a second
  handshake" path — a client bug — and the behavior is equal-or-better than pre-fix
  (which set `intentionalDisconnect`). Acceptable; noted, not filed.
- **Tripwire (already parked in code):** `send()` warns on every attempt while the socket
  is down — `NOTE:` at `sync-client.ts` `send()`. Fine now; downgrade to debug or
  rate-limit if reconnect windows get chatty. No action.

**Honest gaps carried from implement (all reviewed, all acceptable):**

- Transient error arriving *before* `handshake_ack` would leave `connect()` pending until
  the socket closes. Not reachable via the coordinator's message flow (pre-handshake only
  emits fatal handshake errors, which do settle `connect()`). Low risk.
- `message.fatal ?? fallback` means an explicit `fatal:false` from a newer server wins
  over the fallback set even for a code like `AUTH_FAILED`. Intended — server is
  authoritative when it speaks.
- Real-`WebSocket` send buffering/backpressure not exercised (tests use `MockWebSocket`);
  the throw path is simulated. `WebSocket.send` rarely throws in practice.
- `afterEach` teardown auto-disconnects only `createClient()`-made clients; direct
  `new SyncClient(...)` constructor tests never open a socket, so no leak. A future
  direct-construct test that connects would need to disconnect itself.

**Empty categories:** no major findings (nothing filed to `fix`/`plan`/`backlog`); no
correctness/type-safety/resource-cleanup defects found; no doc drift.
