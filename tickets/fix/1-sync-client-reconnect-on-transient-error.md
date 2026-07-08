description: A single transient server-side error permanently stops a sync client from reconnecting for the rest of the process's life, because the client treats every error message as a deliberate shutdown signal.
files:
  - packages/quereus-sync-client/src/sync-client.ts   # lines ~260-268 (error → intentionalDisconnect = true); reconnect, ack, send, lastSentHLC logic
  - packages/sync-coordinator/src/service/coordinator-service.ts  # sends 'error' for transient per-request failures
  - docs/sync.md
difficulty: medium
----

## Problem

The coordinator sends an `error` message for **transient, per-request** failures (for
example a single failed apply). The client, on receiving *any* `error` message, sets
`intentionalDisconnect = true` unconditionally (`sync-client.ts:260-268`). That flag
suppresses auto-reconnect — it exists to distinguish a deliberate client-initiated
disconnect from a dropped connection. So one flaky per-request error is misinterpreted
as "the client meant to disconnect," and **auto-reconnect is disabled for the entire
process lifetime**. A single transient hiccup ends sync permanently.

## Expected behavior

A transient/per-request `error` from the coordinator must **not** disable auto-reconnect.
`intentionalDisconnect` should be set only when the *client itself* initiates a
disconnect, never in response to a server error message. Transient errors should be
surfaced/logged (and the offending request handled), while the connection and its
auto-reconnect behavior remain intact. Distinguish, if the protocol allows, between
fatal errors (which may legitimately stop sync) and transient per-request errors (which
must not) — but the default for an `error` message must be "keep the session alive."

## Related fragilities (address as bullets here, or split a small companion ticket)

These live in the same client and compound the reconnect problem; fix opportunistically
or file a companion `fix/` ticket if they grow the change too much:

- **Stale-socket handlers reject new connects.** Event handlers bound to a dead socket
  can reject or interfere with a freshly established connection. Ensure old-socket
  handlers are fully detached before/at reconnect.
- **Uncorrelated `apply_result` acks.** Apply acknowledgements are not correlated back to
  the specific request that produced them, so a late/duplicate ack can be mis-attributed.
  Add a request/correlation id.
- **Silent `send()` drops.** Failures from `send()` are swallowed, so a message that never
  went out looks like it succeeded (do not eat the exception — surface/log and account for
  the un-sent message).
- **In-memory-only `lastSentHLC`.** The high-water mark of what the client has sent lives
  only in memory, so **every restart re-sends the full history**. Persist it so restarts
  resume rather than replay everything.

## Tests

- Reproducing test: coordinator emits a transient `error` for one request; assert the
  client stays connected / still auto-reconnects (currently it disables reconnect for the
  process lifetime).
- If addressed here: a test that a client restart with a persisted `lastSentHLC` does not
  re-send already-sent history.
