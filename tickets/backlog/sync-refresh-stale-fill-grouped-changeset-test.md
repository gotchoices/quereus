description: Add a test proving that refreshing a materialized view whose stored contents have drifted out of date republishes the corrected rows to peers as one batched change rather than many.
prereq:
files:
  - packages/quereus-sync/test/sync/echo-loop-quiescence.spec.ts          # cold-fill grouping suite (makeFilledPeer); add the stale-drift case here
  - packages/quereus/src/runtime/emit/materialized-view.ts                # emitRefreshMaterializedView → _ensureTransaction (:78)
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts        # rebuildBacking fast path (:1404); stale-trigger docstring (:1391)
  - packages/quereus-store/src/common/backing-host.ts                     # replaceContents replicating arm (:340)
difficulty: medium
----

## Goal

Cover the **second** `replaceContents` call site — `rebuildBacking`'s fast path
(`materialized-view-helpers.ts:1404`) reached by `refresh materialized view` —
for the case where the refresh diffs to **≥1 delta**, and assert that delta is
published to peers as **one grouped change-set under a single HLC**, exactly like
the create-fill path already proven in
`echo-loop-quiescence.spec.ts` (`describe('create-fill of a populated source
publishes one grouped change-set')`).

## Why this was deferred from the create-fill ticket

The create-fill integration test (`sync-create-fill-grouped-changeset-integration-test`)
landed the **refresh-suppression** half cleanly: a `refresh materialized view`
over a *converged* MV recomputes the identical committed set → diffs to zero
deltas → emits nothing. That proves the refresh path is wired through the same
grouped seam and does not double-publish.

The **non-empty** refresh-grouping half was deferred because it is awkward to
stage. `emitRefreshMaterializedView` also runs under `db._ensureTransaction()`
(`materialized-view.ts:78`) and `refreshMaintainedTable` → `rebuildBacking`'s
fast path calls `replaceContents` with the recomputed body rows — so it *should*
group identically. But to get a **non-empty** grouped refresh delta, the
committed MV contents must have **drifted** from the body by ≥1 row **without**
row-time maintenance having applied the drift — the "stale table" trigger in
`rebuildBacking`'s docstring (`materialized-view-helpers.ts:1391`: a body-relevant
source change releases the MV's row-time plan, subsequent source writes drift
unvalidated, and the refresh recomputes the drifted set). In a continuously
row-time-maintained synced MV the committed set never drifts, so a refresh is
always a zero-diff no-op. Staging real drift requires either a source schema
change that marks the MV stale and detaches its row-time plan, or otherwise
forcing the committed backing out of sync with its body — neither stages cleanly
in the existing synced-MV harness without reaching into internals.

## What to build

A new case (preferably in the same cold-fill `describe` block) that:

- Stages a genuine stale drift: bring the MV `stale` and detach its row-time
  maintenance (the natural lever is a body-relevant `alter` on `src`, mirroring
  whatever marks `derivation.stale = true` and releases the plan), then apply
  source writes that the (now-detached) maintenance does NOT propagate, so the
  committed MV contents lag the body by ≥1 row.
- `refresh materialized view mv` → `rebuildBacking` recomputes the drifted set
  and `replaceContents` diffs to ≥1 insert/update/delete delta.
- Assert (producer side) the refresh delta surfaces as **exactly one** new mv
  `ChangeSet` (one `transactionId`, one base HLC; per-change `hlc` bases match
  the set's), distinct from the create-fill set — i.e. the refresh groups under
  its own single HLC tick, not N singletons.
- Assert (peer side) the relayed refresh delta converges on a peer and stays
  quiescent (reuse the `relay`/`changesFor`/`localMvEvents` proofs).

Pin the granularity the same way the create-fill test does (assert the change
count in terms of `driftedRows × nonPkColumns`, not a flat N).

## Caveat / dependency

If the stale-drift setup proves to need engine-internal manipulation that the
public SQL surface cannot express, this may instead need a small test-only hook
(or a unit test in `quereus-store` that drives `replaceContents` mid-transaction
with a non-empty diff). The unit suite (`packages/quereus-store/test/backing-host.spec.ts`)
already covers refresh-path **delta correctness**; the residual risk here is
purely the engine-transaction **grouping** of a non-empty refresh, which is low
given the create-fill path shares the identical seam and is now covered.
