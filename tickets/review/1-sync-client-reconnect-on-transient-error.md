description: Reviewer pass over the fix that stops a single transient server error from permanently killing the sync client's auto-reconnect.
files:
  - packages/quereus-sync-client/src/sync-client.ts          # handleServerError, send, pushLocalChanges, connect/disconnect, scheduleReconnect, detachSocketHandlers
  - packages/quereus-sync-client/src/types.ts                # ErrorMessage.fatal
  - packages/sync-coordinator/src/server/websocket.ts         # sendError(code,message,fatal)
  - packages/quereus-sync-client/test/sync-client.spec.ts     # reconnection + send-failure tests, afterEach teardown
  - packages/sync-coordinator/test/websocket.spec.ts          # fatal-flag assertions
  - docs/sync.md                                              # fatal-vs-transient error section
difficulty: medium
----

## What was wrong

`SyncClient.handleMessage` `case 'error'` set `intentionalDisconnect = true` on **any**
server `error` message. `scheduleReconnect()` early-returns whenever
`intentionalDisconnect` is set, and that flag is only reset in `connect()` — which
reconnect is what would call. So one transient per-request error (e.g.
`APPLY_CHANGES_ERROR` from a single failed apply) permanently disabled auto-reconnect for
the process lifetime.

## What changed

**Core fix — server errors default to keeping the session alive.**
- `types.ts`: `ErrorMessage` gained optional `fatal?: boolean`.
- `sync-client.ts`: new `private stopReconnect` flag, distinct from
  `intentionalDisconnect`. `intentionalDisconnect` now means **only** "the client called
  `disconnect()`"; server-driven shutdown uses `stopReconnect`. Both reset in `connect()`;
  `scheduleReconnect` bails on either.
- New `handleServerError(message)`:
  - Always emits the `error` sync event + `onError` callback.
  - `fatal = message.fatal ?? FATAL_ERROR_CODES.has(message.code)` — trusts the server's
    flag when present, else the client's built-in fallback set (`AUTH_FAILED`,
    `MISSING_DATABASE_ID`, `ALREADY_AUTHENTICATED`) for coordinators predating the flag.
  - **Fatal** → `stopReconnect = true`, `status: 'error'`, settle pending `connect()`.
  - **Transient** → nothing else: connection + auto-reconnect stay intact, no lingering
    `error` status (which would also poison `onclose`'s `wasError = status === 'error'`
    suppression of the `disconnected` transition).
- `websocket.ts`: `sendError(code, message, fatal = false)` now emits `fatal` on every
  error; the three fatal sends pass `true`, the per-request ones stay `false`.

**Folded-in fragilities (cohesive with reconnect):**
- **Stale-socket handlers.** `connect()` (and `disconnect()`) now call
  `detachSocketHandlers(ws)` before `ws.close()`, so a dead socket's deferred `onclose`
  can't fire back into the client and schedule a competing reconnect.
- **Silent send drops.** `send()` returns `boolean` (was `void`), logs a warn on
  socket-not-open and catches+logs+emits on a throwing `ws.send`. `pushLocalChanges` now
  advances `pendingSentHLC` / clears `pendingLocalChangeCount` **only** when the send
  actually left — a dropped send is retried on the next push instead of silently
  advancing the delta-sync watermark past unsent changes.

## Build/test status — GREEN

- `yarn workspace @quereus/sync-client run test` → **54 passing**
- `yarn workspace @quereus/sync-coordinator run test` → **125 passing**
- `yarn workspace @quereus/sync-client run build` (tsc) → clean
- `yarn lint` → clean (only `packages/quereus` has a real lint; touched packages are echo
  no-ops, so type coverage for the changes comes from the tsc build above, not lint)

The `Sync send failed for apply_changes: Error: socket write failed` and
`Unknown sync message type` lines in test output are **expected** — they're the
deliberately-triggered logs from the send-failure and unknown-type tests.

## Use cases to validate / focus review

- **The bug itself:** transient `error` (no `fatal`, code not in fallback set) →
  `intentionalDisconnect` and `stopReconnect` both stay `false`, socket stays open, a
  later close still reconnects. Covered by *"should keep session and reconnect alive after
  a transient server error"*.
- **Fatal still stops:** `fatal: true` (or a fallback code with no flag) →
  `stopReconnect = true`, `status: 'error'`, no reconnect after close, and crucially
  `intentionalDisconnect` stays `false` (fatal ≠ manual disconnect). Covered by the fatal
  + legacy-server tests.
- **Stale socket:** after `connect()` replaces the socket, the old socket's `onclose` is a
  no-op (handlers detached). Covered by *"should not schedule a reconnect from a stale
  socket…"*.
- **Send failure:** a throwing `ws.send` leaves `pendingSentHLC` null and surfaces a
  `Failed to send` error event. Covered by *"should not advance pendingSentHLC when the
  send throws"*.
- **Coordinator wire shape:** fatal codes carry `fatal: true`, transient carry
  `fatal: false`. Covered in `websocket.spec.ts` (MISSING_DATABASE_ID / AUTH_FAILED /
  ALREADY_AUTHENTICATED = true; NOT_AUTHENTICATED / UNKNOWN_MESSAGE = false).

## Known gaps / honest flags (reviewer: treat tests as a floor)

- **Transient error during a pending `connect()` (pre-handshake).** `handleServerError`
  does **not** settle the connect promise on a transient error. In practice per-request
  errors only arrive post-handshake, so `connect()` resolves via `handshake_ack` or
  rejects via `onclose` as before. But a server that emitted a transient error *before*
  `handshake_ack` would leave `connect()` pending until the socket closes. Not tested; low
  likelihood given the coordinator's message flow, but worth a reviewer's eye.
- **`message.fatal ?? fallback` semantics.** An explicit `fatal: false` from a newer server
  wins over the fallback set even for a code like `AUTH_FAILED`. Intended (server is
  authoritative when it speaks), but it means the fallback set only applies when the field
  is *absent*. Confirm this matches the desired contract.
- **Real-WebSocket send semantics not exercised.** Tests use `MockWebSocket`; the
  send-throw path is simulated by overriding `ws.send`. Real `WebSocket.send` buffering /
  backpressure behavior (it rarely throws) is not covered.
- **`afterEach` teardown tracks only `createClient()`-made clients.** Clients built via
  `new SyncClient(...)` directly (only the constructor tests) aren't auto-disconnected —
  fine because they never open a socket or start timers, but a future direct-construct test
  that connects would need to disconnect itself.
- **Tripwire (parked, not a ticket):** `send()` warns on every attempt while the socket is
  down — see the `NOTE:` at `sync-client.ts` `send()`. Fine now; if reconnect windows get
  chatty, downgrade to debug or rate-limit per message type.
