description: The sync client no longer puts the auth token in the WebSocket URL's query string (where proxies and server logs routinely record it); the token now travels only in the handshake message body, which the coordinator already reads.
files:
  - packages/quereus-sync-client/src/sync-client.ts        # connect() ~186: now `this.ws = new WebSocket(url)` (dropped `wsUrl` query-string construction)
  - packages/quereus-sync-client/test/sync-client.spec.ts   # ~380 renamed test asserts URL has no token AND handshake body carries it
difficulty: easy
----

## What changed

`SyncClient.connect` (`sync-client.ts:186`) previously built the WebSocket URL
as `${url}?token=${encodeURIComponent(token)}` when a token was supplied. That
line is now a plain `this.ws = new WebSocket(url);` — the query string is
gone. Nothing else in `connect()` changed: `onopen` still calls
`sendHandshake(databaseId, token)`, which puts the token in the `handshake`
message body sent over the open socket. That is the only place the token now
travels.

## Why this is safe (research done during implement)

- Server-side auth reads only the handshake **message**, never the query
  string. `handleHandshake` (`packages/sync-coordinator/src/service/websocket.ts:110`)
  builds `authContext.token` from `msg.token` (the message body).
  `CoordinatorService.authenticate` (`packages/sync-coordinator/src/service/coordinator-service.ts:216`)
  reads only `context.token` / `context.siteId` / `context.siteIdRaw` — never
  `request.query`. A repo-wide search for `query.token` / `?token=` in
  `packages/sync-coordinator/` found no reader; the only `request.query` use
  is `sinceHLC` on unrelated REST endpoints (`routes.ts:97`).
- No pre-handshake credential is needed at WS-upgrade time — auth happens
  entirely on the post-open handshake message, so dropping the URL query
  string requires no substitute (no custom `Authorization` header, which a
  browser `WebSocket` couldn't set anyway).
- One theoretical caveat: a **custom** `onAuthenticate` hook a consumer writes
  could have read `request.query.token` from `authContext.request`. No
  first-party code does this. If a downstream consumer relied on that
  (undocumented) path, their hook would need to switch to reading
  `context.token` instead — same value, delivered via handshake body. Flagging
  this as the one behavior-visible edge case; no first-party usage was found.

## Test coverage

`packages/quereus-sync-client/test/sync-client.spec.ts` — the test at ~380,
previously "should include token in URL when provided", is now "should not
include token in URL, sending it in the handshake body instead". It asserts:
- `ws.url` does **not** contain `token=my-token`
- the sent `handshake` message's `.token` field equals `'my-token'`

Full suite run: `yarn workspace @quereus/sync-client test` — **52 passing**,
no failures (package name is `@quereus/sync-client`, not
`@quereus/quereus-sync-client` — the ticket's suggested command had the wrong
scope, correct one used). `yarn workspace @quereus/sync-client run build`
(tsc) also clean, no type errors. Lint for this package is a no-op
(`echo 'No lint configured'`) per repo convention — not a real check.

## Gaps / things the reviewer should double-check

- Did not test this against a live `sync-coordinator` instance end-to-end
  (only unit tests with the mock WebSocket in this package) — the
  cross-package auth-path claim above is from static code reading, not an
  integration run. Worth a quick sanity check if coordinator-side handshake
  code has changed recently.
- Did not grep outside this monorepo (e.g. any external consumers of the
  sync-client package) for reliance on the old query-string token — can't from
  this repo. Flagging as a possible (if unlikely) breaking change for external
  callers who relied on the URL carrying the token.
