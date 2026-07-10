description: When a client asks the sync server to resume a partial download, the server trusts the client's description of where to resume without checking it, so a malformed or hostile request can drive the resume off the rails.
files:
  - packages/sync-coordinator/src/server/websocket.ts          # handleResumeSnapshot (~269)
  - packages/sync-coordinator/src/service/coordinator-service.ts # resumeSnapshotStream (~469)
  - packages/quereus-sync/src/sync/snapshot-stream.ts           # resumeSnapshotStream / SnapshotCheckpoint
----

## Problem

`resume_snapshot` accepts the client-supplied `checkpoint` (`SnapshotCheckpoint`:
`snapshotId`, completed-table set, entry offsets, `siteId`, `hlc`) and feeds it straight into
the resume stream without validation. A malformed or adversarial checkpoint (bogus offsets,
unknown/oversized table set, mismatched `snapshotId`/`siteId`, out-of-range `hlc`) drives the
resume with unchecked input.

Surfaced by the same review as the shared-protocol work; separable from it.

## Direction / open questions (for the fix pass)

- Define what a *valid* checkpoint is: bounds on offsets, `completedTables` membership against
  the actual snapshot's tables, `snapshotId` recognized/owned by this session, `siteId`/`hlc`
  well-formed and consistent with the session.
- Decide the failure response: reject with an `error` (which code? fatal?) vs. silently
  restart the snapshot from the beginning.
- Confirm whether checkpoints are server-issued (and thus could be signed/opaque) or purely
  client-held — that changes whether validation or authentication is the right guard.

Security-adjacent input hardening; needs a validation design before implementation.
