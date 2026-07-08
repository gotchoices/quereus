description: When a replica bootstraps from a snapshot, previously-deleted rows can come back from the dead, and a peer with a badly wrong clock can permanently poison data because the clock-sanity check runs only after the bad data has already been saved.
files:
  - packages/quereus-sync/src/sync/snapshot-stream.ts     # lines ~72, ~272 — snapshot omits tombstones; clears receiver tombstones
  - packages/quereus-sync/src/sync/change-applicator.ts   # line ~513 — drift/clock check placement
  - packages/quereus-sync/src/hlc.ts                       # line ~329 — HLC wallTime validation
  - docs/sync.md
difficulty: hard
----

## Problem

Two independent robustness defects in the snapshot/apply path, both able to
**de-converge replicas** (leave two replicas permanently disagreeing).

**1. Snapshots omit tombstones → deleted rows resurrect.**
A snapshot captures live rows but **not tombstones** (the records that mark a row as
deleted). On snapshot bootstrap — including **every S3 restore** — the receiver's
existing tombstones are **cleared** (`snapshot-stream.ts:72,272`) and none are streamed
back in. So after bootstrap the receiver has no memory that row R was deleted. A
straggler write for R that arrives later (or was already in flight) is applied as if R
were simply absent, **resurrecting a deleted row**. Two replicas that bootstrapped at
different points then disagree about whether R exists — permanent divergence.

**2. Clock-drift rejection runs after the data is already committed.**
A peer whose wall clock is far ahead produces HLC timestamps in the future. The
Last-Writer-Wins (LWW) merge treats higher HLC as newer, so a peer 60 seconds ahead
lands **unbeatable far-future wins**. The drift check that is supposed to reject such a
peer executes **after** the data and its CRDT metadata have already been committed
(`change-applicator.ts:513`) — so the poisonous far-future values are durably written,
and only *then* the batch "fails". The rejection is too late to protect the store: the
bad LWW winners are already in place and will beat every legitimate future write.

## Expected behavior

- **Snapshots must carry tombstones.** Introduce a **tombstone chunk type** in the
  snapshot stream so deletions travel with the snapshot. On bootstrap the receiver ends
  up with the sender's tombstones instead of an empty tombstone set, so a straggler
  write for a deleted row is correctly suppressed and deleted rows stay deleted across
  bootstrap/S3 restore.
- **Validate the clock in phase 1, before committing anything.** The HLC `wallTime`
  drift check must run in the **validation phase** — before any data or CRDT metadata is
  written — so a peer with unacceptable drift is rejected up front and never lands
  far-future LWW winners. `hlc.ts:329` is the wallTime validation site; wire it into the
  pre-commit phase of the applicator (`change-applicator.ts`).

## Investigation / tests

- Snapshot format: add the tombstone chunk type to the stream producer and consumer;
  ensure fresh-apply clears then repopulates tombstones from the stream (not just
  clears). Cross-check against `snapshot-stream-resume-clears-completed-metadata`
  (complete) — that handled *resume* preservation; this is about *including* tombstones
  in the payload in the first place, a distinct gap.
- Reproducing tests:
  - Delete row R, snapshot, bootstrap a fresh receiver, then deliver a stale write for
    R; assert R stays deleted (currently resurrects).
  - Apply a batch from a peer whose wallTime is far ahead; assert the batch is rejected
    in validation and **no** data/CRDT metadata was committed (currently commits then
    fails).
