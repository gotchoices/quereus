description: On a seam throw (e.g. inbound batch violates a commit-time global assertion), the sync store-adapter leaves the violating storage rows applied but its derived effects (MV deltas, Database.watch dispatch) unwound; the retry's value-identical upserts are suppressed so the seam batch is EMPTY and the derived effects are never re-driven — incremental MVs diverge from the base table for that row until a manual refresh.
files:
  - packages/quereus-sync/src/sync/store-adapter.ts            # seam call + the doc-comment that pins current behavior
  - packages/quereus/src/core/database-external-changes.ts     # batch savepoint unwinds derived effects on throw
  - packages/quereus-store/src/common/store-table.ts           # applyExternalRowChanges no-op (value-identical upsert) suppression
  - packages/quereus-sync/test/sync/store-adapter-seam.spec.ts # "seam-throw propagation" test pins the divergence as current behavior
difficulty: hard
----

# Seam-throw retry does not re-drive the seam → MV/watch divergence for the violating row

## Problem

`createStoreAdapter` applies inbound rows in two stages per invocation:

1. `StoreTable.applyExternalRowChanges(ops)` writes the rows to **committed**
   storage immediately (trust-the-origin; no coordinator transaction), and
2. one end-of-invocation `Database.ingestExternalRowChanges(batch)` replays the
   **derived** effects inside a batch savepoint — change capture
   (`Database.watch` dispatch + commit-time global assertions), row-time MV
   maintenance, opt-in parent-side FK actions.

When the seam throws — the documented headline case is a **commit-time global
assertion** that the inbound (column-LWW-merged) row state violates — the batch
savepoint unwinds *only* the derived effects. The storage rows stay applied
(correct per trust-the-origin), and the throw propagates out of `applyToStore`,
so the sync layer leaves CRDT metadata uncommitted and the same changes
re-resolve on the next attempt.

On that retry, re-application is a **value-identical upsert** against the
already-committed row, which `StoreTable.applyExternalRowChanges` suppresses as
a no-op. The seam batch is therefore **empty**, the assertion is never
re-evaluated, CRDT metadata commits, and convergence completes — but the
derived effects for the violating row (the MV row delta, the watch dispatch)
that were unwound on the first attempt are **never re-driven**.

Net result: an incremental (row-time) materialized view over the synced table
stays diverged from the base table for that row until something forces a full
MV refresh; a `Database.watch` subscriber never sees the change. A full-rebuild
MV self-corrects on its next rebuild trigger; an incremental one does not.

This is currently **documented and tested as the actual behavior** (the
adapter doc comment and the `seam-throw propagation through the sync layer`
test in `store-adapter-seam.spec.ts`), and was flagged by the implementer for
reviewer judgment. It is filed here because closing it is a design change, not
a tweak.

## Why it is narrow but real

- Triggers only when an inbound batch's merged row state violates a **local**
  commit-time global assertion (divergent assertion definitions across peers,
  or a CRDT column merge producing a state no origin row ever held). For
  deployments without global assertions over synced tables, the seam does not
  throw and there is no divergence.
- The data itself is not lost — the base table holds the (trusted) row. Only
  the **derived** projections (MV, watch) diverge, and only until a refresh.

## Expected behavior / options to weigh

The design question is what a re-driven seam should look like:

- **Re-derive on retry from effective state.** Instead of letting the
  suppressed retry produce an empty batch, have the adapter (or a new seam
  entry point) recompute the derived effects for already-committed rows that
  the prior seam attempt failed to apply — e.g. a "report committed rows
  without re-writing storage" path that feeds the seam the effective
  before/after images read from storage.
- **Quarantine the poison batch.** Surface the assertion failure as a typed,
  host-visible event with the offending rows, rather than retrying forever
  (the current doc text calls the retry-forever case the host's policy), and
  schedule the affected MV(s) for refresh.
- **Couple storage + derived atomicity.** Apply storage inside the same
  seam transaction so a throw unwinds both (changes the trust-the-origin
  posture — storage rows would NOT persist on assertion failure; weigh against
  the CRDT requirement to retain origin-trusted data).

Pick the posture, then update the adapter doc comment, `docs/materialized-views.md`
§ External row-change ingestion / DML replay vs. seam, and the
`store-adapter-seam.spec.ts` test that currently pins the divergence.

## Related

- `sync-apply-per-change-errors-ignored` — the adjacent wart that CRDT metadata
  commits for changes reported in `result.errors`; a mid-table throw in
  `applyExternalRowChanges` (non-atomic: earlier ops already committed to
  storage, none reported) lands in that ticket's territory too.
