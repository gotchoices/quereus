description: Decide whether snapshot bootstrap should re-validate global assertions over the converged state. Bootstrap skips the engine seam entirely (to defer MV maintenance + watch capture), which also drops the seam's commit-time global-assertion evaluation — so a snapshot now installs data without ever checking `create assertion` invariants.
files:
  - packages/quereus-sync/src/sync/store-adapter.ts            # bootstrap flush skips the seam; finalizeBootstrap() only refreshes MVs + notifies
  - packages/quereus-sync/src/sync/snapshot-stream.ts          # footer issues bootstrapFinalize
  - packages/quereus-sync/src/sync/snapshot.ts                 # one-shot path issues bootstrapFinalize
  - packages/quereus/src/core/database.ts                      # ingestExternalRowChanges (evaluates assertions); refreshAllMaterializedViews (does not)
  - packages/quereus-sync/test/sync/store-adapter-seam.spec.ts # "assertion failure propagates" — incremental seam DOES evaluate assertions
difficulty: medium
----

# Snapshot bootstrap: assertion enforcement over the converged state

## Background

The engine ingestion seam (`Database.ingestExternalRowChanges`) bundles four
post-write facets: `Database.watch` change capture, row-time materialized-view
maintenance, opt-in parent-side FK actions, **and commit-time global-assertion
evaluation**. The incremental sync path drives the seam and therefore enforces
`create assertion` invariants on every applied batch — pinned by
`store-adapter-seam.spec.ts` › "seam-throw propagation … assertion failure
propagates, leaves CRDT metadata uncommitted; retry converges".

The snapshot-bootstrap work (`sync-bootstrap-defer-mv-maintenance`) makes a
bootstrap flush **skip the seam call outright** so that MV maintenance and watch
capture defer to a single end-of-snapshot `bootstrapFinalize`
(`Database.refreshAllMaterializedViews()` + coarse `notifyExternalChange`). A
side effect: the finalize refreshes MVs but **does not evaluate global
assertions**, so bootstrapped data is never assertion-checked at all.

Before that change, each snapshot flush called the seam, so assertions *were*
evaluated per flush — but over **partial** snapshot data (a flush is one chunk;
tables stream children-before-parents), which could spuriously fail a valid
snapshot for any cross-row / cross-table assertion. So neither the old nor the
new behavior evaluates assertions correctly over the *complete* snapshot.

## The question to resolve (needs human sign-off)

Pick the intended contract for global assertions over a wholesale snapshot load:

1. **Trust the origin, do not re-validate** (current behavior). A complete
   snapshot already satisfied the origin's assertions, so re-checking on the
   receiver is redundant — consistent with the seam's documented trust-the-origin
   posture (it re-validates no CHECK / NOT NULL / UNIQUE either). Lowest cost;
   risk is that a corrupt or hostile snapshot silently installs
   invariant-violating data. If chosen, the only work is to keep the docs/comments
   honest (already noted) and close this ticket.

2. **Re-validate at finalize over the converged state.** After
   `refreshAllMaterializedViews()`, evaluate every active global assertion once
   against the now-complete data (the correct point — full data present, no
   partial-flush false positives). A failure should propagate like a finalize
   throw: leave the checkpoint in place / not emit `synced`, so the load is
   retriable. This needs an engine primitive — there is currently no public
   "evaluate all global assertions" entry point analogous to
   `refreshAllMaterializedViews()`; `ingestExternalRowChanges` only evaluates
   assertions as a side effect of a change batch's commit.

## Expected outcome

A decision recorded in the next-stage ticket, and either (1) docs confirming the
trust-the-origin contract, or (2) an engine primitive to evaluate all global
assertions plus a `bootstrapFinalize` hook that calls it and fails retriably.
Decide too whether incremental and bootstrap paths should agree (today the
incremental path enforces assertions and bootstrap does not).
