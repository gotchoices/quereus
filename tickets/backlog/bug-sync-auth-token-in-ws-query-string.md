description: The sync client puts the auth token in the WebSocket URL's query string, where proxies and server logs routinely record it; the token is already sent safely in the connection handshake, so the URL copy should be dropped.
files:
  - packages/quereus-sync-client/src/sync-client.ts   # connect() ~189: `${url}?token=${encodeURIComponent(token)}`
  - packages/sync-coordinator/src/server/websocket.ts # handleHandshake reads msg.token (body), not the query string
----

## Problem

`SyncClient.connect` appends the auth token to the WebSocket URL as a query parameter
(`sync-client.ts:189`). Credentials in a URL query string are logged by proxies, load
balancers, and access logs, and can leak via `Referer`/history — a well-known credential
exposure.

The same token is **already** sent in the WebSocket handshake message body
(`sendHandshake` includes `token`), which is what the coordinator reads in `handleHandshake`
(`msg.token`). So the query-string copy appears redundant.

Surfaced by the same review as the shared-protocol work.

## Direction / open questions (for the fix pass)

- Confirm the coordinator does **not** rely on the query-string token anywhere at the WS
  upgrade step (only `msg.token` from the handshake body). If it does, move that read to a
  header or the handshake body first.
- Then drop the query-string token from `connect()`; if a pre-handshake credential is needed
  at upgrade time, use an `Authorization`-style header instead of the URL.
- Interacts with the `protocolVersion` handshake work (`sync-protocol-migrate-and-version`),
  which also touches the handshake — sequence after it or coordinate so both handshake edits
  land coherently.
