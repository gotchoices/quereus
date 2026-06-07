description: |
  Preventive documentation + comment-correctness pass for the cross-pull context
  shadowing hazard fixed in `streaming-aggregate-stale-group-context-shadows-child-filter`.
  The audit (see "Audit result" below) found NO new bug instances: every streaming
  emitter that publishes a source-attribute context while still pulling its child
  already handles the hazard. The deliverables are therefore (1) a docs invariant
  section in `docs/runtime.md`, (2) correcting the stale "newest→oldest scan" mental
  model in `docs/runtime.md` and `project.ts` to match the current `attributeIndex`
  last-`set`-wins mechanism, and (3) plan-shape guard tests for the two non-aggregate
  handled instances so their mitigations can't silently regress.
files:
  - packages/quereus/src/runtime/context-helpers.ts                      # RowContextMap.attributeIndex + RowSlot.reactivate() — the hazard surface; add a doc-comment pointer to the invariant
  - packages/quereus/src/runtime/emit/aggregate.ts                       # reference fix (tear down before pull); lines ~429-438
  - packages/quereus/src/runtime/emit/asof-scan.ts                       # merge variant: rightSlot.reactivate() at lines 469/477 (handled instance)
  - packages/quereus/src/runtime/emit/window.ts                          # streaming variant: promote()/myDesc delete+set at lines ~952-983 (handled instance)
  - packages/quereus/src/runtime/emit/project.ts                         # lines 21-25: stale "newest→oldest" rationale comment to correct
  - docs/runtime.md                                                      # line ~348 stale resolution model; add invariant section near "Row Context Management" (~310) and "Column Reference Resolution" (~347)
  - packages/quereus/test/plan/streaming-aggregate-filter-shadow.spec.ts # reference test pattern for the guard tests

# Streaming-emitter cross-pull context-shadow invariant (docs + guards)

## Background — the hazard

`RowContextMap` (in `context-helpers.ts`) keeps a flat, last-`set`-wins
`attributeIndex: Array<{rowGetter, columnIndex}>` for O(1) column resolution.
`createRowSlot(...).set(row)` mutates only the slot's boxed `ref.current`; it does
NOT touch `attributeIndex`. Therefore a slot can reclaim the index for its
attribute IDs only by being the most recent `context.set(descriptor, …)` (slot
creation, or an explicit `reactivate()`), never by `set(row)` alone.

The hazard, in one sentence:

> **Invariant — a streaming operator must not leave a row context built from its
> source's attribute IDs winning the `attributeIndex` while it pulls its child for
> the next input row.**

If it does, the child's per-row `slot.set(nextRow)` cannot reclaim the shared
attribute IDs, so the parent's stale context silently shadows the child's
current-row reads (e.g. a `Filter` directly below an aggregate reads the previous
group's representative row instead of its current row — the exact bug fixed in
`streaming-aggregate-stale-group-context-shadows-child-filter`).

The mirror image is equally real: an operator whose source-attr context is
shadowed by a still-running child cursor (the asof-merge "asc" peek case) must
`reactivate()` its slot *before yielding* so downstream resolves through the
operator's intended row, not the child cursor's look-ahead row.

## Audit result (timeless — record of what was checked)

All `packages/quereus/src/runtime/emit/*.ts` emitters that yield rows while an
input iterator is still being pulled and that set contexts keyed by source
attribute IDs were reviewed. **No unhandled instance exists today.**

Handled instances of the exact pattern (keep these working — the guard tests below
lock them):
- `aggregate.ts` streaming GROUP BY — tears the representative-row context down
  *before* pulling the next source row (the reference fix, ~lines 429-438).
- `asof-scan.ts` merge variant — `rightSlot.reactivate()` before yielding the
  matched / null-padded row (lines 469, 477).
- `window.ts` streaming variant — registers its own `myDesc` and `promote()`s
  (delete + re-`set`) it at the row being yielded, re-promoting after each child
  pull (~lines 952-983, 1104-1124).

Structurally safe (no live source-attr context across a child pull) — reasons:
- Co-side fully materialized before any yield: `merge-join.ts`, `bloom-join.ts`,
  `asof-scan.ts` hash variant.
- Full build precedes emit, no source pull during yield: `hash-aggregate.ts`,
  `window.ts` buffered path.
- Child slot is created *after* the operator's slot, so the child wins
  `attributeIndex` and holds the current row; operator's slot is redundant but
  harmless: `join.ts` (nested loop), `filter.ts`, `project.ts`. In nested-loop
  join the co-side iterator is fully drained (child closes/`delete`s its slot,
  rebuilding the index onto the operator's slot) before any null-pad yield.
- Yields the just-pulled row immediately, no interleave: `distinct.ts`,
  `internal-recursive-cte-ref.ts`.
- Sets no row-attribute context at all: `sequencing.ts`, `set-operation.ts`,
  `recursive-cte.ts` (uses `tableContexts`, not row contexts).
- Disjoint attribute IDs / per-row forked slots: `fanout-lookup-join.ts`.

## Stale documentation to correct

Two places still describe the pre-`attributeIndex` resolution model and must be
brought in line, because that obsolete model is what makes the hazard
counter-intuitive:

- `docs/runtime.md` ~line 348: "The runtime now searches the context from
  newest → oldest, so the most recently-pushed scope wins." This is now only the
  *fallback* in `resolveAttribute` (when the indexed entry's row isn't populated);
  the fast path is the flat `attributeIndex` (last-`set`-wins, NOT
  insertion-order-newest-wins).
- `packages/quereus/src/runtime/emit/project.ts` lines 21-25: the comment claims
  "Output slot is created FIRST so it is older… resolveAttribute searches
  newest→oldest, so the source slot (created second) wins." Under `attributeIndex`
  the actual winner for shared IDs is whichever slot called `context.set` last
  (in practice the child source slot created on first pull). The behaviour is
  still correct, but the stated reason is wrong and misleads future authors.

## Edge cases & interactions

- **Index vs. fallback divergence.** The invariant is about the `attributeIndex`
  fast path. The newest→oldest *fallback* in `resolveAttribute` only fires when
  the indexed entry's `rowGetter()` returns a non-array/short row. Docs must not
  conflate the two; describe the fast path as authoritative and the scan as a
  fallback for the not-yet-populated-slot case.
- **`reactivate()` semantics.** Document that `reactivate()` re-`set`s the
  descriptor (re-winning the index) and is the correct tool for the
  child-shadows-operator direction (asof-merge), while *tear-down-before-pull*
  (delete) is the tool for the operator-shadows-child direction (aggregate). Both
  are valid resolutions of the same invariant; pick by which side must win at the
  moment of the next pull.
- **Stacked same-attr operators.** The streaming-window `promote()` comment
  (~lines 952-983) describes the stacked-Window case where an outer operator's
  later-registered slot would shadow an inner one; the docs note should reference
  this as the canonical example of why `set(row)` alone is insufficient and
  re-insertion (delete+set) is needed.
- **Guard-test fragility.** The aggregate guard test asserts the *plan shape*
  (Filter directly below the streaming operator, no interposed Sort) because a
  Sort would drain the child and mask the bug. The new guard tests must likewise
  assert no Sort/materialization is interposed between the handled operator and a
  source-column-referencing Filter, or they silently stop guarding anything.
- **Cross-platform / store paths.** Pure-runtime context behaviour; no store
  interaction. `yarn test` (memory vtab) is sufficient; do not gate on
  `test:store`.

## TODO

- Add an **"Invariant: source-attr contexts and child pulls"** subsection to
  `docs/runtime.md` under the Row Context Management area (~line 310), stating the
  invariant verbatim from above, the two resolution tools (tear-down-before-pull
  vs. `reactivate`), and citing the three handled emitters as worked examples.
- Correct `docs/runtime.md` ~line 348 to describe `attributeIndex` last-`set`-wins
  as the fast path and newest→oldest as the fallback (not the primary model).
- Correct the stale rationale comment in `project.ts` lines 21-25 to reference the
  `attributeIndex` last-`set`-wins mechanism (child source slot, created on first
  pull, wins for shared IDs) — keep the behaviour, fix the reason.
- Add a short doc-comment near `RowContextMap.attributeIndex` and
  `RowSlot.reactivate()` in `context-helpers.ts` pointing to the new
  `docs/runtime.md` invariant section (one-line "see …" pointers; do not duplicate
  the prose).
- Add a plan-shape guard test for the **streaming window** handled instance,
  modeled on `test/plan/streaming-aggregate-filter-shadow.spec.ts`: a query whose
  plan places a `Filter` referencing a source column directly below a streaming
  `Window` (no interposed Sort), asserting both the shape and correct results.
  If the planner cannot be coerced into that shape without a Sort, document the
  attempt in the test file and fall back to a `.sqllogic` correctness case that
  exercises the streaming window over a residual-filtered source.
- Add an analogous guard (plan-shape or `.sqllogic` correctness) for the
  **asof-scan merge** `reactivate()` path: an asof merge whose downstream
  references the right side's columns through a filter/projection, asserting the
  matched-row value is read (not the right cursor's look-ahead row).
- Run `yarn build` then `yarn test 2>&1 | tee /tmp/test.log; tail -n 80 /tmp/test.log`
  (or `Tee-Object` under PowerShell) and confirm green. Lint
  `packages/quereus` with single-quoted globs.
