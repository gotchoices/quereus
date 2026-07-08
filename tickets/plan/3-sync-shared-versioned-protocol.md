description: The sync client and server each keep their own hand-maintained copy of the wire format they use to talk to each other; the two copies have already drifted apart and there is no version number, so a mismatched client and server can silently misunderstand each other.
files:
  - packages/quereus-sync-client/src/serialization.ts        # client codec copy
  - packages/sync-coordinator/src/common/serialization.ts    # coordinator codec copy (drifted)
  - packages/quereus-sync/src/sync/protocol.ts               # candidate home for a shared protocol module
  - docs/sync.md
  - docs/sync-coordinator.md
difficulty: hard
----

## Problem

The sync client (`@quereus/sync-client`) and the coordinator (`sync-coordinator`) each
maintain their **own separate copy** of the wire protocol — the message serialization
and the union of message types they exchange. Nothing keeps the two copies in sync, and
they have **already diverged**:

- The two serialization codecs disagree — e.g. one tolerates a missing `schemaMigrations`
  field and the other does not; one uses typed shapes where the other uses
  `Record<string, unknown>`.
- The message unions differ — `resume_snapshot` / `snapshot_chunk` exist on only one
  side.
- There is **no protocol version** anywhere, so a client and coordinator built at
  different times cannot detect that they disagree; they just silently misinterpret each
  other's messages.

## Expected behavior / direction

**One shared protocol module** — the single source of truth for message types and their
serialization, living in `@quereus/sync` (candidate: `src/sync/protocol.ts`) and consumed
by *both* the client and the coordinator. Neither side keeps its own codec copy.

**A `protocolVersion` handshake.** The client and coordinator exchange a protocol version
on connect and refuse (or explicitly negotiate) when incompatible, so a drift is detected
loudly at connect time instead of causing silent misbehavior.

This plan should resolve:

- The exact shared message-type union and codec API, reconciling the current two copies
  (which side is correct for each divergence — `schemaMigrations` tolerance, typed vs
  `Record<string, unknown>`, the `resume_snapshot`/`snapshot_chunk` messages).
- Where the shared module lives and how both packages depend on it without a circular
  dependency.
- The handshake semantics: strict-match vs. minimum-supported-version negotiation, and
  what happens on mismatch.

## Adjacent items surfaced by the same review finding

Park or fold as appropriate — each is smaller than the protocol unification. The
store-manager close/acquire race is already carved out as its own fix ticket
(`1-sync-store-manager-close-acquire-race`); the rest below should be triaged in this
plan into implement/ tickets or `backlog/` (`bug-`/`debt-` prefixed):

- **Change-log pruning never wired into production.** A pruning path exists but is not
  actually invoked in the running coordinator, so the change log grows unbounded.
- **`resume_snapshot` trusts an unvalidated client checkpoint.** The coordinator accepts
  the client-supplied checkpoint without validation, letting a malformed/hostile
  checkpoint drive the resume.
- **Auth token in the WebSocket URL query string.** Credentials in the query string are
  logged by proxies/servers; move to a header or the handshake body.
- **S3 snapshot fully stringified in memory** despite a comment claiming streaming — a
  large snapshot is materialized entirely in memory before upload/download.
- **No socket backpressure** — the coordinator writes to sockets without respecting the
  consumer's drain, risking unbounded buffering under a slow client.

## Notes

Cross-package API + wire-compatibility design; resolve the module boundary and handshake
here before emitting implement tickets. Sequence the store-manager race fix
(`1-sync-store-manager-close-acquire-race`) independently — it does not depend on this
redesign.
