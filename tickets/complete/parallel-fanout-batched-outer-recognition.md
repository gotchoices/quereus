description: Cost-model recognition rule (`rule-fanout-batched-outer`) that flips an already-formed `FanOutLookupJoinNode` from `serial` to `batched` outer mode, wrapping the outer in `EagerPrefetchNode` for isolation. Implemented, reviewed, build + lint + full suite green.
prereq: parallel-fanout-lookup-join-batched-outer
files: packages/quereus/src/planner/rules/join/rule-fanout-batched-outer.ts, packages/quereus/src/planner/optimizer.ts, packages/quereus/src/planner/optimizer-tuning.ts, packages/quereus/test/optimizer/parallel-fanout-batched.spec.ts, docs/optimizer.md, docs/runtime.md
----

## What landed

A PostOptimization rule, **`rule-fanout-batched-outer`** (priority 16, matching
`PlanNodeType.FanOutLookupJoin`), that flips an already-formed `FanOutLookupJoinNode`
from the default `serial` outer mode to `batched`. It is a post-pass over the node
`rule-fanout-lookup-join` builds in `Structural` — by PostOptimization, physical
selection has finalized leaf `expectedLatencyMs` / `estimatedRows` / `concurrencySafe`.

**Decision logic (all must hold, else stay serial):** not already `batched` (idempotence);
no `cross` branch (deferred to `parallel-fanout-lookup-join-cross-mode`); `branchCount <
outerBatchConcurrency`; `max(branch.expectedLatencyMs) >= batchedOuterThresholdMs` (25 ms);
`outerRowEstimate(outer) >= batchedOuterMinRows` (256; unknown estimate fails the gate);
`outer.physical.concurrencySafe === true`. On flip it rebuilds the node with
`outerMode='batched'` and the outer wrapped in `EagerPrefetchNode` (buffer =
`maxOuterReadAhead`), preserving `branches` / `concurrencyCap` / `preserveAttributeIds`.

Two new `OptimizerTuning.parallel` knobs: `batchedOuterThresholdMs` (25),
`batchedOuterMinRows` (256). `outerBatchConcurrency` / `maxOuterReadAhead` pre-existed.

The **EagerPrefetch wrap is the load-bearing correctness mechanism**: the batched driver
pumps the outer concurrently with live per-row forks, so wrapping the outer makes its
sub-plan run against the prefetch's own forked context (mutations land on the fork, never
on the shared `rctx.context` the per-row forks bump), and the batched pump then drains a
pure buffer. This neutralizes both documented hazards (torn non-outer reads; strict-fork
violation under a nested fork). Decision: **batched implies prefetch**.

## Review findings

### Checked

- **Read the implement diff first** (`git show 1a24d212`): the rule, its optimizer
  registration, the two tuning knobs, the 8-case spec, and the `docs/optimizer.md` /
  `docs/runtime.md` updates — before reading the handoff summary.
- **Node-contract conformance.** Confirmed the rule's calls match the real constructor
  signatures: `FanOutLookupJoinNode(scope, outer, branches, concurrencyCap,
  preserveAttributeIds?, outerMode?)` and `EagerPrefetchNode(scope, source, bufferSize?)`.
  `withChildren` round-trips `outerMode`; `getLogicalAttributes` exposes `outerMode` (the
  field the spec parses out of `query_plan` properties). `toString` renders `, batched`.
- **Pass placement.** Verified the live priorities in `optimizer.ts`: `eager-prefetch-probe`
  15, `fanout-batched-outer` 16, the two `async-gather` rules 17, `materialization-advisory`
  30 — so the docstring's "between 15 and 17, before 30" claim is accurate, and the
  inserted `EagerPrefetchNode` is in place before the advisory walks the tree. No target
  overlap with the neighbor rules (each matches a distinct node type).
- **Physical recomputation of rule output.** Confirmed `PlanNode.physical` is lazily
  computed and cached per node, deriving `concurrencySafe` as the AND of children. So the
  freshly-built `EagerPrefetchNode` + `FanOutLookupJoinNode` get correct physical props on
  first access without an explicit re-run of the physical pass — and the emitter/runtime
  reading `outer.physical.concurrencySafe` sees `true` (the gated source propagates through).
- **`concurrencySafe` provenance.** Traced it to `RetrieveNode.computePhysical`:
  `getModuleConcurrencyMode(module) !== 'serial'`. `MemoryTableModule` declares
  `'reentrant-reads'` (⇒ safe), which is *why* the firing test's memory outer clears the
  concurrency gate — previously implicit, now pinned by a test (below).
- **`outerRowEstimate` helper.** Reviewed for soundness: `??` preserves a `0` estimate
  (not coerced to the fallback), single-relation descent cannot loop (plan trees never
  return self in `getRelations`), and a multi-relation (join) outer returns `undefined` ⇒
  conservative gate failure. Logic is correct.

### Found & fixed inline (minor)

- **The `concurrencySafe` outer gate had zero test coverage** — and it is the gate the
  entire EagerPrefetch-isolation rationale rests on (an outer pumped concurrently with
  branch forks *must* be concurrency-safe). Added
  `does NOT flip when the outer is not concurrency-safe`: a `'serial'`-mode memory module
  backs the outer while the branches stay high-latency + reentrant, so latency /
  cardinality / budget all pass and only the concurrency gate holds the node serial. The
  test also confirms the fan-out still *forms* over a serial-unsafe outer (formation does
  not require it), isolating the gate. Parameterized `setup3Branches` with an `outerModule`
  argument to add this DRY-ly. Spec is now 9 cases (all pass; the new case passes under
  strict-fork too). The `'serial'` override is applied via a `readonly`-stripping cast
  because `MemoryTableModule` narrows `concurrencyMode` to a literal — typechecks clean.

### Gaps left as-is (with reasons — not blockers)

- **`outerRowEstimate` single-relation descent is untested.** Memory fixtures resolve a
  *defined* estimate (0), so `direct` is never `undefined` and the descent branch is never
  reached; exercising it needs an outer whose node-level estimate is undefined but a leaf's
  `physical.estimatedRows` is set, which requires a fixture shape not in tree. Verified
  correct by inspection; conservative on the multi-relation outer the handoff flagged.
- **Strict-fork outer-pump safety is reasoned + structural, not executed under
  `QUEREUS_FORK_STRICT=1`.** Every fan-out *execution* test skips under strict because of
  the pre-existing Sort/Project-above-fan-out false positive; since this rule is
  Project-rooted, that fires first and masks a direct test of the outer-pump fix. Confirmed
  the *plan-shape* assertions all pass under strict (7 pass, exec skips as designed). A
  runtime-level strict test driving `runFanOutLookupJoinBatched` is the prereq runtime
  ticket's domain, not this recognition rule's.
- **No timing/overlap test** (the runtime ticket owns the cross-row-overlap assertions;
  this rule only *selects* batched) and **`batchedOuterMinRows=256` is an unvalidated
  first-cut** (≈4× read-ahead). Both acknowledged in the handoff; neither is a correctness
  issue.

### New tickets filed

None. No major findings surfaced. The streaming-`cross` + batched combination remains
deferred to the already-filed `parallel-fanout-lookup-join-cross-mode`; this rule
explicitly refuses to flip any node carrying a `cross` branch.

### Validation

- `yarn workspace @quereus/quereus run build` — clean (EXIT 0).
- `yarn workspace @quereus/quereus run lint` — clean (EXIT 0).
- `tsc --noEmit` (includes `test/`) — clean (EXIT 0), covering the new cast.
- Full suite (`node test-runner.mjs`) — **3563 passing, 0 failing, 9 pending** (was 3562;
  +1 from the new concurrency-gate test). Golden plan sweep (3 cases) unchanged.
- `parallel-fanout-batched.spec.ts` under `QUEREUS_FORK_STRICT=1` — 7 passing, 1 pending
  (exec-equivalence test skips by design).
