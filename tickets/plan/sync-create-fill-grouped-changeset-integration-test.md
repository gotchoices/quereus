description: Add an end-to-end test proving that turning on replication for a materialized view built over a table that ALREADY has rows publishes those rows to peers as one batched change, so old peers receive them at deploy.
prereq:
files:
  - packages/quereus-sync/test/sync/echo-loop-quiescence.spec.ts   # existing replicate-MV sync harness (makePeer / relay / settle)
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts # materializeView create-fill (:486), rebuildBacking fast path (:1387)
  - packages/quereus-store/src/common/backing-host.ts              # replaceContents replicating arm (the unit-covered delta logic)
difficulty: medium
----

## Why

The `sync-derivation-fill-publication` change made a replicate-opted-in store
backing's `replaceContents` (create-fill / full-rebuild refresh) publish genuine
deltas against the committed contents. The delta computation is thoroughly
unit-tested in `packages/quereus-store/test/backing-host.spec.ts` (fresh-fill,
identical-refill suppression, partial diff, refresh-to-empty, DESC/NOCASE
re-key, commit-first-with-pending-txn). What is **not** covered end-to-end is the
headline migration scenario at the engine/sync layer:

> Create a `materialized view … using store with tags ("quereus.sync.replicate" = true)`
> over a source that **already holds rows**, so the create-fill emits one `insert`
> per cold row, and assert those inserts surface to a peer as **one grouped
> change-set under a single HLC** (the `StoreEventEmitter.startBatch`/`flushBatch`
> grouping that the engine create-fill transaction drives).

The existing replicate-MV integration test
(`packages/quereus-sync/test/sync/echo-loop-quiescence.spec.ts`) builds its MV
over an **empty** `src` (create-fill emits nothing) and then exercises only the
subsequent row-time maintenance path. The grouping machinery is pre-existing and
shared with that maintenance path (both route through
`coordinator.queueEvent → emitter`), so residual risk is low — but the cold-fill
delivery is the entire point of the ticket and deserves a direct assertion.

## What to add

In the `echo-loop-quiescence` harness (or a sibling spec), add a case that:

- seeds `src` with rows **before** creating the tagged MV (so create-fill is a
  non-empty fill),
- relays peer A → peer B,
- asserts peer B's MV backing converges to the filled rows, AND
- asserts the fill arrived as a single grouped change-set (one HLC / one
  applied set), not N ungrouped singletons.

A `rebuildBacking`/`refresh materialized view` variant over a populated,
constraint-less backing (the second `replaceContents` call site,
`materialized-view-helpers.ts:1387`) would round it out — confirm its
engine-transaction posture groups identically to create-fill.

Test-only; no production code change expected.
