description: The sync coordinator can hand out an already-closed storage handle when one part of the system closes a store at the same moment another part asks to use it, leading to operations against a dead database.
files:
  - packages/sync-coordinator/src/service/store-manager.ts   # close/acquire lifecycle
  - packages/sync-coordinator/test/store-manager.spec.ts
difficulty: medium
----

## Problem

The coordinator's store manager pools/hands out LevelDB store handles keyed by some
identifier, closing them when idle or on shutdown. There is a **race between close and
acquire**: an acquire can retrieve a handle that a concurrent close is in the middle of
(or has just finished) tearing down, so the caller receives an **already-closed LevelDB
handle** and its subsequent reads/writes fail (or worse, operate on a half-closed
resource). This is a real correctness/robustness bug, not a stylistic one: under
concurrent access the manager can vend a dead handle.

## Expected behavior

Acquire and close must be mutually consistent: an acquire either returns a **live,
usable** handle or (re)opens one — it must **never** return a handle that a concurrent
close has retired. Equivalently, a close must not tear down a handle that an in-flight
acquire is about to use. The lifecycle should be serialized/reference-counted so that:

- A handle is only closed when there are no outstanding users and no in-flight acquire.
- An acquire that races a close waits for the close to finish and then gets a freshly
  opened handle, rather than the stale closed one.

## Investigation / direction

- Read `store-manager.ts`'s acquire and close paths; identify the window where a handle
  is observable in the map after close has begun (or before open completes).
- Likely fix: reference-count handles and/or guard the map with a per-key async lock so
  acquire/close for the same key serialize; on acquire, validate the handle is open (or
  reopen) before returning it.
- Reproducing test in `store-manager.spec.ts`: interleave a close and an acquire for the
  same key and assert the acquired handle is open and usable.

## Note

This is carved out as a standalone fix from the broader sync-design review finding
(`3-sync-shared-versioned-protocol` in plan/, which enumerates several coordinator-side
design items). This one is a concrete bug worth fixing independently of that redesign.
