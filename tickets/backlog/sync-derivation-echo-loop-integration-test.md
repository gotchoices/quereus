description: Add the real two-peer echo-loop quiescence integration test for the `quereus.sync.replicate` change-log opt-in. The single-host echo seam (value-identical re-derivation → no BackingRowChange → no DataChangeEvent) is already pinned by a unit test; what is missing is the cross-peer end-to-end assertion that a replicated derivation does not ping-pong between two synced peers. The implement stage left this as a bodyless *pending* mocha test in `packages/quereus-store/test/backing-host.spec.ts`.
prereq:
files:
  - packages/quereus-store/test/backing-host.spec.ts            # the pending `it('echo-loop quiescence across two synced peers …')` stub + its design comment
  - packages/quereus-store/src/common/backing-host.ts           # the emit seam under test (toDataChangeEvent / replicates)
  - packages/quereus-sync/                                       # change log, HLC, ingest — the second-peer machinery the harness needs
----

# Two-peer echo-loop quiescence integration test

## What to prove

The load-bearing invariant of `quereus.sync.replicate` is that a replicated
maintenance write closes its own echo loop:

1. Peer A applies a source write → A's maintained-table/MV derivation runs →
   the backing host queues a local `DataChangeEvent` per realized
   `BackingRowChange` → the sync layer logs the derived row.
2. Peer B ingests A's source change **and** A's logged derived row.
3. B re-derives the ingested source change. Because the re-derivation is
   value-identical to the derived row B just ingested, the
   `mv-noop-upsert-suppression` contract produces **no** `BackingRowChange`,
   hence **no** `DataChangeEvent`, hence **no** B-origin change-log entry.
4. Therefore there is no ping-pong: B logs zero B-origin derived entries for a
   change that originated at A.

## Why it is not done yet

This needs a store + `@quereus/sync` two-peer harness (HLC clocks, change log,
ingest path) that does not exist in the `quereus-store` test tree. The implement
stage pinned the single-host seam (`suppresses a value-identical upsert (the echo
seam): no change, no event`) and left a bodyless pending test
(`it('echo-loop quiescence across two synced peers (integration; tracked
follow-up)')`) as an in-code breadcrumb pointing here.

## Scope / specifications

- Two independent peers (separate stores + sync state), a source table replicated
  to both, and a maintained table / materialized view derived from it carrying
  `quereus.sync.replicate = true`.
- Drive a source write on A; run A→B sync; assert B's derived contents converge
  AND B emits no B-origin derived change-log entries (the quiescence assertion,
  not just eventual convergence).
- Decide the right home: a new spec under `quereus-sync` (where the ingest/HLC
  machinery lives) is likely cleaner than `quereus-store`. Remove the pending
  stub from `backing-host.spec.ts` once the real test lands.
- Consider a second round-trip (B→A) to assert the loop is fully quiescent in
  both directions, not just A→B.
