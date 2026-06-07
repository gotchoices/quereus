description: |
  Review the cross-pull context-shadow invariant work. NOTE: the original ticket's
  premise was WRONG. It assumed the audit found "NO new bug instances" and that
  this was a docs-only + guard-tests pass. In fact the streaming-window emitter had
  a real, reproducible correctness bug of exactly this invariant — it was masked in
  the prior agent's exploration by monotone test data. This implement run found it,
  fixed it (`window.ts`), and locked it with a load-bearing guard test, in addition
  to the documentation/comment corrections the ticket specified.
files:
  - packages/quereus/src/runtime/emit/window.ts                          # THE FIX: demote() before each child pull (streaming run, ~lines 952-1010, 1138-1141)
  - packages/quereus/src/runtime/emit/project.ts                         # corrected stale "newest→oldest" rationale comment (~lines 21-30)
  - packages/quereus/src/runtime/context-helpers.ts                      # doc-comment pointers on attributeIndex + RowSlot.reactivate()
  - docs/runtime.md                                                      # corrected resolution model + new "source-attr contexts and child pulls" invariant section
  - packages/quereus/test/plan/streaming-window-filter-shadow.spec.ts    # NEW guard (window) — verified to FAIL without the fix
  - packages/quereus/test/plan/asof-merge-reactivate-shadow.spec.ts      # NEW guard (asof merge reactivate path)
  - packages/quereus/src/runtime/emit/aggregate.ts                       # reference fix (tear-down-before-pull), unchanged
  - packages/quereus/src/runtime/emit/asof-scan.ts                       # reactivate() mitigation, unchanged
  - packages/quereus/test/plan/streaming-aggregate-filter-shadow.spec.ts # pre-existing reference guard

# Streaming-emitter cross-pull context-shadow invariant — review handoff

## What the invariant is

`RowContextMap` keeps a flat, **last-`set`-wins** `attributeIndex` for O(1) column
resolution. `RowSlot.set(row)` only mutates the boxed ref — it does NOT touch the
index. So a slot reclaims an attribute ID only via `context.set` (slot creation or
`reactivate()`), never by `set(row)` alone.

> **Invariant:** a streaming operator must not leave a row context built from its
> source's attribute IDs winning the `attributeIndex` while it pulls its child for
> the next input row.

Two resolution tools, picked by which side must win at the next pull:
- **tear-down-before-pull (`delete`)** — operator-shadows-child (aggregate, window)
- **`reactivate()` before yield** — child-shadows-operator (asof merge)

## The deviation from the ticket (read this first)

The ticket claimed "every streaming emitter … already handles the hazard" and
listed `window.ts` as a *handled* instance. **That was wrong.** The streaming
Window registers its own `myDesc` (source attr IDs) and `promote()`s it (delete +
set) to win the index for its own callbacks and at each yield — but it left that
context **winning across the next child pull**, so a residual `Filter` directly
below it read the Window's *last-yielded* row instead of its current row.

Why it was missed: the prior agent's exploration used monotone data
(`val` = 10,20,30,40,50, filter `val > 15`). Once the threshold is crossed it
stays crossed, so reading the previous row's `val` gives the *same* filter
decision — the bug produces correct output. Adversarial data (adjacent rows
straddling the threshold) exposes it immediately.

Reproduction (pre-fix), table `t(id PK, val)` = (1,100),(2,5),(3,100),(4,5),(5,100):
```
SELECT id, val, ROW_NUMBER() OVER (ORDER BY id) AS rn FROM t WHERE val > 50
  expected: id 1,3,5 (rn 1,2,3)
  pre-fix : [{id:1,rn:1},{id:2,val:5,rn:2}]   ← id 2 wrongly passes val>50; ids 3,4,5 vanish
```

## The fix

`window.ts` streaming `run`: added a `demote()` (delete `myDesc`, clear
`myRegistered`) call at the **end of each `for await` iteration**, after the
yield-while loop and before pulling the next source row. `promote()` re-wins on
the next row. This mirrors the aggregate reference fix (tear-down-before-pull).
The existing re-promotion (win for own callbacks + at yield) is preserved, so the
stacked-window and downstream-Project guarantees still hold; `demote()` only
releases the index across the pull so the deepest child reclaims it.

## Validation performed (this is a floor, not a ceiling)

- `yarn build` — clean.
- `yarn test` — 5086 passing in `@quereus/quereus` (9 pending), all other
  workspaces green, 0 failing. (The sync-manager "boom"/"batch write failed" log
  lines are intentional error-injection in those tests, not failures.)
- `yarn lint` (packages/quereus, single-quoted globs) — clean.
- The 41-test window+asof spec suite (`optimizer/monotonic-window`,
  `optimizer/asof-scan`, `planner/window-function-types`) still passes — including
  the streaming-vs-buffered correctness comparisons and multi-ranking-function
  cases.
- **Guard regression-proof:** temporarily disabling `demote()` makes both window
  correctness tests fail with the exact corrupted output above, while the
  plan-shape and buffered-control tests stay green. The guard is load-bearing.
- The asof `reactivate()` path was confirmed load-bearing in the prior run
  (disabling it returned the look-ahead bid for every left row); the new asof
  guard pins the merge plan shape + matched-row correctness.

## Use cases / what to scrutinize in review

- **Stacked streaming windows.** The original reason `promote()` re-wins was the
  stacked-Window case. I reasoned the fix preserves it (promote still re-wins each
  iteration; demote only fires before the pull) and the streaming-vs-buffered
  equivalence tests pass — but there is **no explicit guard for a streaming Window
  stacked over another streaming Window over a residual Filter**. Worth a targeted
  check or a new guard if the reviewer wants belt-and-suspenders.
- **Partition boundaries & RANGE-mode buffering.** `demote()` fires every
  iteration including ones that buffer (peer group not yet closed) and at
  partition boundaries (where `finalizePartition` + `promote(row)` run mid-loop).
  Reasoned safe; covered indirectly by the running-SUM guard and existing sliding
  /RANGE tests, but not by a dedicated multi-partition straddling-filter case.
- **Other emitters.** I re-reviewed the audit's "structurally safe" list. Window
  was the unique offender because it is the only emitter that manually re-promotes
  to *win* the index across pulls; filter/project/distinct deliberately let the
  deepest child win (no re-promote), aggregate tears down, asof reactivates, and
  the join/co-side-materialized paths never hold a live source-attr context across
  a pull. Reviewer may want to spot-check `fanout-lookup-join.ts` (forked per-row
  slots) and the window *buffered* path for completeness.
- **Guard fragility.** Both new guards assert plan shape (streaming Window with a
  standalone Filter directly below and NO Sort; asof `strategy: merge` with the
  Filter above) precisely because a Sort/materialization would drain the child and
  silently neuter the correctness assertion. If the planner stops producing these
  shapes, the shape assertions fail loudly rather than passing vacuously.
- **Docs.** `docs/runtime.md` Column Reference Resolution was rewritten: the
  `attributeIndex` last-`set`-wins fast path is now authoritative and the
  newest→oldest scan is documented as the not-yet-populated-slot fallback. New
  "source-attr contexts and child pulls" subsection states the invariant and both
  resolution tools with the three worked emitters.

## Out-of-scope / not done

- Did not write `.sqllogic` cases; the plan/ guard specs are stronger here (they
  pin the exact hazard shape, which sqllogic cannot assert). The window query that
  triggers the bug could additionally be added to a window sqllogic file if the
  team prefers logic-test coverage — low priority given the plan guard.
- No store-path testing (`test:store`) — this is pure-runtime context behaviour
  with no store interaction, per the ticket.
