description: A LEFT 1:n (not-at-most-one) equi-lookup chain now folds into a `FanOutLookupJoinNode` as a `cross-left` branch (outer-preserving NULL-pad on an empty branch) instead of bailing to a nested-loop left join.
files: packages/quereus/src/planner/nodes/fanout-lookup-join-node.ts, packages/quereus/src/planner/rules/join/rule-fanout-lookup-join.ts, packages/quereus/src/planner/rules/join/rule-fanout-batched-outer.ts, packages/quereus/src/runtime/emit/fanout-lookup-join.ts, packages/quereus/test/optimizer/parallel-fanout.spec.ts, packages/quereus/test/runtime/fanout-lookup-join.spec.ts, docs/optimizer.md, docs/runtime.md
----

## Summary

Added a `cross-left` `FanOutBranchMode`: a LEFT join whose non-preserved side is
a parameterized equi-lookup that is *not* provably at-most-one (no FK, or
FK→non-unique) folds into a single `FanOutLookupJoinNode` instead of bailing to a
nested-loop left join. Match-present semantics are identical to `cross` (1:n
Cartesian product); an empty branch emits one NULL-padded factor row so the outer
row is preserved, and the branch's output attributes are nullable-widened (like
`atMostOne-left`).

Two exported predicates on `fanout-lookup-join-node.ts` centralize the
mode-family logic as a single source of truth:
- `isLeftBranchMode` → `atMostOne-left | cross-left` (outer-preserving ⇒
  nullable-widen + NULL-pad on empty).
- `isCrossBranchMode` → `cross | cross-left` (1:n cross factor ⇒ memory-guarded
  + cardinality-multiplied).

These are threaded through `recognizeBranch`, the `crossGuardsPass` filter,
`preserveAttrs` widening, the node's `buildAttributes` / `getType` /
`computePhysical` (join-type `left`) / `computeEstimatedRows`, the emit
composer's empty-buffer path, and the `rule-fanout-batched-outer` exclusion.

## Review findings

**Process:** Read the implement diff (`5fc17c08`) with fresh eyes before the
handoff summary. Scrutinized correctness, DRY, type safety, FD propagation,
cardinality estimation, and the test surface. Ran build, full test suite, and
lint.

### Correctness — checked, no defects found
- **Mode-literal coverage.** Swept every `FanOutBranchMode` consumer across
  `packages/quereus/src`. All scattered literal checks are now routed through
  `isLeftBranchMode` / `isCrossBranchMode`; no site was missed. `isAtMostOne` in
  emit correctly still excludes `cross-left` (it is 1:n, so exempt from the
  at-most-one CONSTRAINT assertion).
- **composeOuterRows semantics.** The odometer product is position-agnostic. An
  empty `cross-left` branch pushes a single NULL-pad factor (preserve); an empty
  inner/cross sibling still returns `[]` (drop the whole outer row) even when a
  `cross-left` is present — verified by both the runtime regression test and the
  SQL mixed-chain execution-equivalence test.
- **NULL-pad width.** `padLengths` is derived from `outputColCount`
  (= `outputAttrs.length`), independent of the (empty) buffer, so an empty
  cross-left pads to the correct width. Shared by the serial and batched drivers
  identically.
- **FD propagation.** `computePhysical` passes join-type `left` for `cross-left`
  to `propagateJoinFds` with the pre-existing conservative empty equi-pair lists
  — consistent with `atMostOne-left`; right-side keys are not preserved across
  the left join.
- **estimatedRows === 0 audit (beyond the handoff's stated gap).** The handoff
  flagged that `computeEstimatedRows` can under-count a `cross-left` node to 0
  when `childEst` resolves to 0 (synthetic memory leaves), framing it as
  affecting only the memory guard. I verified the broader risk: **no rule treats
  `estimatedRows === 0` as provably empty.** The only estimate-equality consumer
  is `rule-join-greedy-commute` (`=== 1`, colCount 0); `rule-empty-relation-
  folding` is purely structural and never reads `estimatedRows`. So the 0-estimate
  is cosmetic/cost-only and cannot drop the preserved outer rows. Confirmed not a
  correctness defect.

### Tests — adequate, extended coverage already present
- Optimizer: recognition (modes in declared order), inert-on-local-memory,
  execution-equivalence vs the rule-disabled nested-loop baseline **including
  empty-match NULL-pad rows** (`p=3` both branches empty → `{null,null}`; `p=4`
  one branch empty), both memory guards (`maxCrossProduct` / `maxCrossBranchRows`)
  tripping, and a mixed `atMostOne-left + cross + cross-left` chain with an
  execution-equivalence run.
- Runtime: direct `composeOuterRows` / `runFanOutLookupJoin` coverage — non-empty
  1:n product, empty-branch NULL-pad + outer preservation, pad width from
  `outputColCount`, mixed `cross × cross-left`, and the regression that an empty
  inner `cross` sibling still drops the outer row alongside a `cross-left`.
- Edge cases at the runtime level exercise `cross-left` in both first and
  non-first branch positions; since `composeOuterRows` is position-agnostic, no
  position-specific logic is untested. No additional tests were warranted.

### Minor findings fixed inline
None — the diff required no edits.

### Major findings (new tickets filed)
None. The four "known gaps" disclosed in the handoff were each verified as
genuine, pre-existing/parity-consistent, and *not* correctness defects:
- Cardinality is an upper-leaning approximation (no `max(childEst,1)` for
  cross-left) — parity with `cross`, cosmetic per the estimate audit above.
- `forkExecTest` skips the two execution-equivalence tests under
  `QUEREUS_FORK_STRICT=1` — pre-existing Sort/Project-above-fan-out false
  positive, matches the existing `cross` block; recognition/shape tests still run.
- No real remote-vtab fixture — consistent with the entire fan-out suite (the
  synthetic `HighLatencyMemoryModule` drives the cost gate).
- Mixed-mode FD propagation uses empty per-branch equi-pair lists — pre-existing
  conservatism already tracked as a `computePhysical` follow-up in the optimizer
  docs. None of these block correctness.

### Docs — verified accurate
`docs/optimizer.md` (branch-mode listing, cross/cross-left recognition,
memory-guard note including the cross-left factor, tuning-knob notes, out-of-scope
line, batched-outer exclusion) and `docs/runtime.md` (added `cross-left`,
documented the `isLeftBranchMode` / `isCrossBranchMode` predicates) reflect the
new reality. The stale "no rule constructs a cross node yet" claim was correctly
removed from `docs/runtime.md`.

## Validation (re-run during review)
- `yarn workspace @quereus/quereus run build` → exit 0, clean.
- `yarn workspace @quereus/quereus run test` → **3575 passing, 9 pending, 0 failing**.
- Targeted `--grep "FanOutLookupJoin|ruleFanOutLookupJoin"` → 103 passing, 2 pending.
- ESLint on the four changed source files → clean.
