description: The sync client puts the auth token in the WebSocket URL's query string, where proxies and server logs routinely record it; the token is already sent safely in the connection handshake, so drop the URL copy.
files:
  - packages/quereus-sync-client/src/sync-client.ts        # connect() ~186: `${url}?token=${encodeURIComponent(token)}`
  - packages/quereus-sync-client/test/sync-client.spec.ts   # ~380 "should include token in URL" — must be inverted
difficulty: easy
----

## Problem

`SyncClient.connect` appends the auth token to the WebSocket URL as a query
parameter:

```ts
// packages/quereus-sync-client/src/sync-client.ts:186
const wsUrl = token ? `${url}?token=${encodeURIComponent(token)}` : url;
this.ws = new WebSocket(wsUrl);
```

Credentials in a URL query string are logged by proxies, load balancers, and
access logs, and can leak via `Referer`/history — a well-known credential
exposure.

## Research findings (this fix pass)

**The query-string token is fully redundant — nothing reads it server-side.**

- The same token is sent in the handshake **message body**. On `onopen`
  (`sync-client.ts:191`) the client calls `sendHandshake(databaseId, token)`,
  which puts `token` in the `handshake` message (`sync-client.ts:550-561`).
- The coordinator authenticates on the `handshake` **message**, not at the WS
  upgrade. `handleHandshake` (`websocket.ts:110`) builds `authContext` with
  `token: msg.token` (from the body) and calls `service.authenticate`.
- `CoordinatorService.authenticate`
  (`packages/sync-coordinator/src/service/coordinator-service.ts:216`) reads
  only `context.token`, `context.siteId`, `context.siteIdRaw`. It **never**
  reads `request.query`. A grep for the query-string token (`?token=`,
  `query.token`) across `packages/sync-coordinator/` finds no reader — the only
  `request.query` uses are for `sinceHLC` on the REST endpoints
  (`routes.ts:97`), unrelated to auth.

**No pre-handshake credential is needed at upgrade time.** Because auth happens
on the handshake message (post-open), the client does not need to present a
credential during the WS upgrade. So the fix is a plain drop of the query
string — no `Authorization` header substitution is required. (Browser
`WebSocket` cannot set custom upgrade headers anyway; the handshake-body token
is exactly the design that sidesteps that.)

**Custom auth hooks.** `authContext` also carries `request`, which a consumer's
`onAuthenticate` hook *could* read `request.query.token` from. No first-party
code does. Dropping the query string is the whole point of the fix (keep
credentials out of URLs); a hook that wants the token should read
`context.token` (the handshake body), which is populated identically.

**Sequencing.** The `protocolVersion` handshake work
(`sync-protocol-migrate-and-version`) has already landed — `PROTOCOL_VERSION`
is stamped in `sendHandshake` and asserted throughout the tests. No conflict
with this edit; it only touches the URL construction, not the handshake body.

## TODO

- In `sync-client.ts` `connect()`, replace the token-in-URL construction with a
  plain `this.ws = new WebSocket(url);` (drop the `wsUrl` conditional at ~186).
  Leave the `onopen` → `sendHandshake(databaseId, token)` path untouched — that
  is what delivers the token now.
- `connectionToken` is still stored for reconnect and still passed to
  `sendHandshake` via the reconnect `connect(...)` call (`sync-client.ts:727`).
  Confirm nothing else consumed `wsUrl`/the query token; nothing does.
- Invert the existing test `sync-client.spec.ts:380` ("should include token in
  URL when provided"): assert the WS `url` does **not** contain `token=`, and
  instead assert the sent `handshake` message carries the token in its body
  (`getSentMessages().find(m => m.type === 'handshake').token === 'my-token'`).
  Rename the test to reflect the new expectation.
- Build + test: `yarn workspace @quereus/quereus-sync-client test` (Vitest).
  Run `yarn lint` for the sync-client package if it has a real lint (most
  non-quereus packages are no-op).
