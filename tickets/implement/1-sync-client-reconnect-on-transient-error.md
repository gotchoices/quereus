description: A single transient server-side error permanently stops the sync client from reconnecting for the rest of the process's life, because the client treats every error message as a deliberate shutdown signal. Fix so only genuinely fatal errors stop reconnection.
files:
  - packages/quereus-sync-client/src/sync-client.ts        # error handler (~260-268), scheduleReconnect (~468), onclose/onerror handlers (~160-175), send() (~399)
  - packages/quereus-sync-client/src/types.ts              # ErrorMessage type (~196)
  - packages/sync-coordinator/src/server/websocket.ts       # sendError() (~87); fatal vs transient sends
  - packages/quereus-sync-client/test/sync-client.spec.ts   # MockWebSocket harness + reconnection describe block
  - docs/sync.md
difficulty: medium
----

## Confirmed root cause

`sync-client.ts` `handleMessage` `case 'error'` sets `this.intentionalDisconnect = true`
unconditionally on **any** server `error` message (currently ~lines 260-268):

```ts
case 'error':
  this.emitSyncEvent('error', `Server error: ${message.message} (${message.code})`);
  this.options.onError?.(new Error(message.message));
  // Server explicitly rejected — stop auto-reconnect to avoid tight loops.
  this.intentionalDisconnect = true;
  this.setStatus({ status: 'error', message: message.message });
  this.settleConnect(new Error(message.message));
  break;
```

`scheduleReconnect()` (~line 468) early-returns whenever `intentionalDisconnect` is set:

```ts
private scheduleReconnect(): void {
  if (this.intentionalDisconnect || !this.connectionUrl || !this.options.autoReconnect) {
    return;
  }
  ...
```

`intentionalDisconnect` is only reset in `connect()`. Once a transient error sets it, the
socket's `onclose` fires, `scheduleReconnect` bails, and — since nothing calls `connect()`
again (reconnect is exactly what would) — **auto-reconnect is dead for the process
lifetime**. One flaky per-request error ends sync permanently.

**Confirmed empirically** (fix-stage repro): after
`ws.simulateMessage({ type: 'error', code: 'APPLY_CHANGES_ERROR', ... })`, the client's
`intentionalDisconnect` reads `true` and its own `onclose` skips reconnect.

## Coordinator error taxonomy (from `sync-coordinator/src/server/websocket.ts`)

The coordinator's `sendError(code, message)` emits `{ type: 'error', code, message }`.
Two distinct classes:

- **Fatal** — coordinator *also* closes the socket, reconnect can't succeed as-is:
  - `AUTH_FAILED` (then `socket.close(4001)`)
  - `MISSING_DATABASE_ID` (then `socket.close(4002)`)
  - `ALREADY_AUTHENTICATED` (protocol misuse; socket left open but not recoverable)
- **Transient / per-request** — socket stays open, session is fine, only one request failed:
  - `APPLY_CHANGES_ERROR`, `GET_CHANGES_ERROR`, `SNAPSHOT_ERROR`,
    `NOT_AUTHENTICATED`, `UNKNOWN_MESSAGE`, `MESSAGE_ERROR`

The ticket's "transient hiccup" is `APPLY_CHANGES_ERROR` (one failed apply).

## Design

**Default for an `error` message = keep the session alive.** Do not touch
`intentionalDisconnect` in the error handler at all — that flag must mean *only* "the
client called `disconnect()`". Introduce a separate concept for "server told us to stop".

Make the coordinator authoritative rather than hardcoding a code list in the client:

- Add optional `fatal?: boolean` to `ErrorMessage` in `types.ts`.
- In `websocket.ts`, pass `fatal: true` on the fatal `sendError` calls (`AUTH_FAILED`,
  `MISSING_DATABASE_ID`, `ALREADY_AUTHENTICATED`); leave the per-request ones transient
  (fatal falsy). Keep `sendError`'s signature ergonomic (e.g. optional 3rd arg).
- Client behavior in `case 'error'`:
  - Always: emit the `error` sync event + `onError` callback (unchanged).
  - **Transient** (`!message.fatal`): log/surface, keep the connection and its
    auto-reconnect intact. Do **not** set `intentionalDisconnect`. Do **not** put the
    client into a permanent `status: 'error'` that outlives the request — a per-request
    failure shouldn't masquerade as connection death (note that `onclose` uses
    `wasError = status === 'error'` to suppress the `disconnected` transition; a lingering
    transient-error status would poison that path too).
  - **Fatal** (`message.fatal`): set a new private `stopReconnect = true` (NOT
    `intentionalDisconnect`), set `status: 'error'`, `settleConnect(error)`. The coordinator
    closes the socket; `onclose` → `scheduleReconnect` must also bail when `stopReconnect`.

- Add `private stopReconnect = false;` alongside `intentionalDisconnect`. Reset it to
  `false` in `connect()` (same place `intentionalDisconnect` is reset). Update
  `scheduleReconnect`'s guard to `if (this.intentionalDisconnect || this.stopReconnect || ...)`.

Keep a small client-side fallback set of fatal codes for coordinators that predate the
`fatal` flag (older servers won't send it) — treat those known codes as fatal even when
`message.fatal` is absent. Document the set next to it.

## Companion fragilities folded in here (small, cohesive with reconnect)

**Stale-socket handlers reject new connects.** `connect()` does `this.ws.close()` but
leaves the old socket's `onopen/onclose/onerror/onmessage` bound. A late event from the
dead socket (e.g. its deferred `onclose`) can still fire into the client and, e.g.,
schedule a competing reconnect or clobber status. Before replacing `this.ws`, null out the
old socket's four handlers (`ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null`) so
only the live socket drives the client. Do the same defensively at the top of
`scheduleReconnect`'s timer callback path if needed.

**Silent `send()` drops.** `send()` (~line 399) silently no-ops when
`readyState !== OPEN`, and `ws.send()` can itself throw. A dropped message currently looks
like success — notably `pushLocalChanges` sets `pendingSentHLC` and clears
`pendingLocalChangeCount` regardless of whether the bytes left. Per AGENTS.md ("don't eat
exceptions silent"): have `send()` return a boolean (or throw) and log when it can't send;
callers that advance state on a send (`pushLocalChanges`) must not advance the HLC
watermark / clear pending counts when the send didn't go out.

## Reproducing test — harness caveat (important)

The existing `MockWebSocket` uses **static** `instances`/`lastInstance` shared across tests,
and prior `reconnection` tests leave **live reconnect timers** running (a client with
`autoReconnect: true` keeps firing `connect()` on a timer). During fix-stage repro this
polluted a naive `MockWebSocket.instances.length` assertion — the count grew from a
*leaked prior-test client* reconnecting, not the client under test, yielding a false pass.

For a reliable test:
- Assert on the **client under test's own** observable behavior, not the global instance
  count. Good signals: after a transient `error`, `(client as any).intentionalDisconnect`
  stays `false`; and the *same* client's `onclose` schedules a reconnect (spy on
  `client.connect` / track a WS created for that client), whereas after a `fatal` error it
  does not.
- Prefer isolating leaked timers: give reconnecting tests a teardown that
  `await client.disconnect()` (stops timers), or capture the pre-test instance count and
  scope assertions to sockets created by the current client. Add a short `afterEach` that
  disconnects any client the test created.

## TODO

### Phase 1 — core fix
- [ ] `types.ts`: add `fatal?: boolean` to `ErrorMessage`.
- [ ] `sync-client.ts`: add `private stopReconnect = false`; reset in `connect()`.
- [ ] `sync-client.ts`: rewrite `case 'error'` — transient (default) keeps session +
      reconnect; fatal sets `stopReconnect`, `status: 'error'`, settles connect. Never set
      `intentionalDisconnect` from a server error.
- [ ] `sync-client.ts`: add fatal-code fallback set for servers without the `fatal` flag.
- [ ] `sync-client.ts`: update `scheduleReconnect` guard to also check `stopReconnect`.
- [ ] `websocket.ts`: mark `AUTH_FAILED` / `MISSING_DATABASE_ID` / `ALREADY_AUTHENTICATED`
      sends as `fatal: true`.

### Phase 2 — folded fragilities
- [ ] `sync-client.ts`: detach old-socket handlers before replacing `this.ws` in
      `connect()` (and defensively when reconnecting).
- [ ] `sync-client.ts`: make `send()` surface/log failures; stop `pushLocalChanges` from
      advancing `pendingSentHLC` / clearing counts on a failed send.

### Phase 3 — tests + docs
- [ ] Add reproducing test: transient `error` → client stays connected, `intentionalDisconnect`
      stays false, reconnect still scheduled. Contrast: fatal `error` → no reconnect.
- [ ] Add test: stale-socket `onclose` after `connect()` replaced the socket does not
      schedule a stray reconnect.
- [ ] Add test: `send()` failure is observable (returns false / logs) and does not advance
      `pendingSentHLC`.
- [ ] Harden harness: `afterEach` disconnects test-created clients so leaked reconnect
      timers don't pollute later assertions.
- [ ] Update `docs/sync.md`: document fatal-vs-transient error semantics and that a
      transient per-request error never disables auto-reconnect.
- [ ] `yarn workspace @quereus/sync-client run test` green; `yarn lint`.
