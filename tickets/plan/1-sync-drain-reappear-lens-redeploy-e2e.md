description: Add a real-database end-to-end test proving that re-deploying a schema which brings a retired table back into use actually replays the held edits as live rows — matching the coverage the other revival path already has.
prereq:
files:
  - packages/quereus-sync/test/sync/sync-drain-e2e.spec.ts                 # existing real-store revival e2e (inbound create_table) — extend or mirror here
  - packages/quereus-sync/src/sync/sync-manager-impl.ts                    # recordLensDeployment — the detached → present trigger under test
difficulty: medium
----

# Real-engine e2e for the lens-redeploy revival path

## Why

Two reappearance paths trigger a low-latency scoped drain of held out-of-basis changes:

1. an inbound `create_table` (`sync-drain-reappear-inbound-ddl`), and
2. a local `apply schema` lens redeploy that re-maps a basis table from `detached` back into the
   basis (`sync-drain-reappear-lens-redeploy`).

Path 1 is covered end-to-end by `sync-drain-e2e.spec.ts`, which drives a real `Database` +
`StoreModule` + `createStoreAdapter` so the drain's held change materializes as a live SQL row
(queried back with `select`, carrying the straggler's origin HLC, and driving `Database.watch`
capture + materialized-view maintenance — the derived effects an in-memory stub cannot fire).

Path 2 is currently covered only at the CRDT-metadata + in-memory-stub level
(`basis-lifecycle-recorder.spec.ts` → `recordLensDeployment — low-latency drain on detached →
re-mapped`). The shared drain machinery (`drainReappearedTables` → `drainHeldChanges` →
`admitGroup` → store adapter) is identical to path 1 and so is already e2e-proven; the only seam
not exercised end-to-end is the `recordLensDeployment` `detached → present` trigger driving a
**real** redeploy. This is low-risk (the trigger is exhaustively unit-covered), but the inbound
path set a parity bar worth matching.

## What to build

Extend `sync-drain-e2e.spec.ts` (or add a sibling spec) with a redeploy-driven revival case:

- A holder peer with a real store-backed table that gets **retired via a lens redeploy** (an
  `apply schema` that no longer maps / no longer includes the basis table, taking it to
  `detached`), while a straggler's edits for it are diverted and held (`quarantine` /
  `store-and-forward`).
- A subsequent `apply schema` redeploy that **re-maps the basis table back** (`detached →
  present`), with `drainOnReappear` on (the default).
- Assert the held edits materialize as live rows through the real store adapter — `select`-backed
  row presence, the straggler's **original origin HLC** preserved, and the held entries cleared —
  exactly as the inbound-path e2e asserts for its `create_table` trigger.

## Expected outcome

The lens-redeploy revival path has the same real-engine confidence as the inbound-`create_table`
path: a held straggler edit becomes a queryable row the instant a redeploy brings its table back,
without waiting on the periodic sweep.
