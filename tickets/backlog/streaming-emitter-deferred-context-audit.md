description: |
  Audit all streaming runtime emitters for the same class of bug fixed in
  `streaming-aggregate-stale-group-context-shadows-child-filter`: an operator that
  leaves an OUTPUT-side row context (built from its source's attribute IDs) live in
  the shared runtime context map while it goes back to pull the next input row from a
  child that publishes the same attribute IDs. Because `RowContextMap.attributeIndex`
  is last-`set`-wins and a child's `RowSlot.set()` does not reclaim the index, the
  parent's stale context silently shadows the child's current-row reads.
files:
  - packages/quereus/src/runtime/context-helpers.ts        # RowContextMap.attributeIndex + RowSlot.reactivate() (the hazard surface)
  - packages/quereus/src/runtime/emit/aggregate.ts         # the instance already fixed (reference pattern)
  - packages/quereus/src/runtime/emit/                     # window.ts, joins, distinct, hash-aggregate, etc. — candidates to audit

# Audit streaming emitters for cross-pull context shadowing

## Why

The streaming-aggregate fix removed one instance of a general hazard: a pull-based
generator that installs a representative/output row context under its source's attr
IDs, `yield`s, and then resumes to pull more input WITHOUT first tearing that context
down. Any emitter that interleaves "publish my output context" with "pull my child"
and shares attribute IDs with that child is exposed. The shared-index mechanics that
make it possible live in `context-helpers.ts` (`attributeIndex` is a flat
last-write-wins array; `createRowSlot.set()` only mutates a boxed ref, so a shadowed
child cannot reclaim its index unless it calls `reactivate()`).

## Scope

Review each streaming emitter that yields rows while an input iterator is still being
pulled and that sets row contexts keyed by source attribute IDs. Candidates: window
functions (`window*.ts`), merge/streaming joins, streaming DISTINCT, and any other
operator using a deferred-cleanup-across-yield pattern. For each, determine whether
its output/representative context can be live during the next child pull; if so, either
tear it down before the pull (as the aggregate fix does) or have it not collide.

This is exploratory: produce fix/plan tickets for any concrete instances found, and a
short note in `docs/runtime.md` describing the invariant ("a streaming operator must
not leave a context built from its source's attribute IDs live while pulling its
child"). No instance is known beyond the fixed aggregate today, so this is a
preventive audit rather than a known bug.
