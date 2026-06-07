description: |
  COMPLETE — cross-pull context-shadow invariant for streaming emitters. The
  implement run found and fixed a real, reproducible correctness bug in the
  streaming Window emitter (it left its source-attr context winning the
  attributeIndex across the next child pull, so a residual Filter directly below
  read the Window's last-yielded row), locked it with a load-bearing guard, and
  corrected the resolution-model docs/comments. Review independently confirmed the
  fix, audited the adjacent emitters, added one extra producible guard, and ran
  the full suite + lint green.
files:
  - packages/quereus/src/runtime/emit/window.ts                          # THE FIX: demote() before each child pull (streaming run)
  - packages/quereus/src/runtime/emit/project.ts                         # corrected stale rationale comment
  - packages/quereus/src/runtime/context-helpers.ts                      # doc-comment pointers on attributeIndex + RowSlot.reactivate()
  - docs/runtime.md                                                      # corrected resolution model + "source-attr contexts and child pulls" invariant
  - packages/quereus/test/plan/streaming-window-filter-shadow.spec.ts    # guard (window) + NEW stacked-window guard added in review
  - packages/quereus/test/plan/asof-merge-reactivate-shadow.spec.ts      # guard (asof merge reactivate path)
  - packages/quereus/src/runtime/emit/aggregate.ts                       # reference fix (tear-down-before-pull), unchanged
  - packages/quereus/src/runtime/emit/asof-scan.ts                       # reactivate() mitigation, unchanged

# Streaming-emitter cross-pull context-shadow invariant — COMPLETE

## Summary

`RowContextMap.attributeIndex` is **last-`set`-wins**: `slot.set(row)` mutates the
boxed ref only; an attribute ID is reclaimed in the index only by `context.set`
(slot creation / `reactivate()`) or restored by `context.delete` (which rebuilds
affected entries from the remaining contexts). The invariant: a streaming operator
must not leave a row context built from its **source's** attribute IDs winning the
index while it pulls its child for the next row, or a pass-through child that
shares those IDs (and only `set(row)`s) reads the parent's stale row.

The streaming Window violated this: it `promote()`s its `myDesc` to win for its own
callbacks and at each yield, but left it winning across the next pull. The fix adds
`demote()` (delete `myDesc`) at the end of each iteration — tear-down-before-pull —
so the deepest child reclaims the index during the pull; `promote()` re-wins on the
next row. Mechanism verified: `RowContextMap.delete` rebuilds the affected index
entries from the remaining contexts (context-helpers.ts:57-81), so the child's slot
re-wins for the shared IDs. Net cost is a wash — the next `promote()` skips its own
`delete` because `myRegistered` is false.

## Review findings

Adversarial pass over commit `cec6371b`. Read the full diff with fresh eyes before
the handoff. Findings by dimension:

### Correctness — the core fix (verified, load-bearing)
- **Independently reproduced the bug and the fix.** Temporarily neutering
  `demote()` (`void demote;`) makes the window guard fail with exactly the
  documented corruption (`id:2/val:5` wrongly admitted; later rows dropped).
  Restored, green. The guard is genuinely load-bearing, not decorative.
- **Pull-point completeness.** The only child pull in `runStreaming` is the top of
  the `for await` loop; `finalizePartition` (window.ts:1273) drains the buffered
  queue and never pulls source. `demote()` at loop-end (window.ts:1141) therefore
  covers every cross-pull window. The partition-boundary branch and the
  source-exhausted trailing `finalizePartition` re-`promote()` correctly and have
  no intervening pull — sound.
- **Stacked / downstream-window interaction (implementer flagged as unguarded).**
  Reasoned through the nesting and confirmed empirically: a streaming inner Window
  re-promotes/demotes around its *own* pull, and is still promoted when it hands a
  row up — which is correct, because the parent wants exactly that yielded row and
  re-`promote()`s the shared IDs anyway. **Added a producible guard** for this
  (streaming inner ROW_NUMBER over the residual Filter feeding a downstream Window)
  — verified load-bearing (disabling `demote()` corrupts it identically). Note:
  two *stacked streaming* Windows are not currently producible — the intermediate
  Project drops `monotonicOn`, so the outer Window falls to the buffered path; the
  new guard covers the reachable form.
- **Audit of adjacent emitters (verified "window was the unique offender").**
  `filter.ts`/`project.ts`/`distinct.ts` create their slot once and only
  `set(row)` per row — they never re-promote, so the deepest child wins; they are
  *victims* the fix protects, not offenders. `aggregate.ts` tears down before the
  pull; `asof-scan.ts` reactivates before yield. `fanout-lookup-join.ts` holds an
  outer-attr slot across child pulls but over **disjoint** attribute IDs (outer vs.
  branch relations), so no shared-ID shadow; the batched driver additionally forks
  per-row contexts (documented load-bearing point, fanout-lookup-join.ts:264-267).

### Tests — happy / edge / regression / interaction
- Existing guards cover ROW_NUMBER, running-SUM, the buffered control, and the
  asof merge-vs-hash control with adversarial straddling data. **Added** the
  stacked-window guard (see above). Full suite: **5087 passing / 9 pending / 0
  failing**; the window+asof optimizer suites still pass.
- **Edge path not coverable (documented, not a defect):** the *partitioned*
  streaming Window's partition-boundary `demote()` path is unreachable with the
  available vtabs — composite-key `monotonicOn` is not advertised, so
  `PARTITION BY` falls to the buffered path (confirmed: the props carry no
  `streaming` key and the buffered path drains the child, so there is no cross-pull
  interleave to guard). This matches the pre-existing note in
  `test/optimizer/monotonic-window.spec.ts`. No guard added because the shape is
  not produced; not a correctness risk while it stays buffered.

### DRY / modular / maintainable
- `promote()`/`demote()` are small, single-purpose, and mirror the aggregate
  reference pattern; the rationale comment is accurate. Guard specs assert plan
  shape (streaming Window, standalone Filter directly below, no Sort) so a planner
  change that drains the child fails loudly rather than passing vacuously. Good.

### Performance
- No regression. `demote()` swaps one `delete` from the next `promote()` to
  loop-end (same per-row delete/set count as before the fix).

### Resource cleanup / error handling / type safety
- `try/finally` still deletes `myDesc` on exhaustion/throw; `demote()` is
  idempotent (`myRegistered` guard). No `any` introduced; no swallowed exceptions.
  Clean.

### Docs
- `docs/runtime.md` Column Reference Resolution rewritten to the authoritative
  last-`set`-wins fast path + newest→oldest fallback, with a new "source-attr
  contexts and child pulls" invariant section naming both resolution tools and the
  three worked emitters. `context-helpers.ts` doc-comments point at it. Verified
  against the code — accurate.

### Disposition
- **Minor (fixed inline):** added the stacked/downstream-window guard.
- **Major (filed):** none.
- No `.pre-existing-error.md` written — the suite is fully green at this SHA.

## Out of scope (carried forward, unchanged from implement)
- No `.sqllogic` cases — the plan/ guard specs pin the exact hazard shape, which
  sqllogic cannot assert. Low priority.
- No store-path testing — pure-runtime context behaviour, no store interaction.
- Partitioned-streaming-window coverage waits on a vtab/setup that advertises
  composite-key `monotonicOn` (tracked by the existing optimizer-spec note).
