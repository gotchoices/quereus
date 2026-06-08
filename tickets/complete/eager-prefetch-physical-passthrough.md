description: `EagerPrefetchNode.computePhysical` override restoring pass-through relational claims (ordering/fds/equivClasses/constantBindings/domainConstraints/monotonicOn) dropped by the default child-merge, plus corrected docstring and regression tests. Reviewed and completed.
files: packages/quereus/src/planner/nodes/eager-prefetch-node.ts, packages/quereus/src/planner/nodes/limit-offset.ts, packages/quereus/src/planner/nodes/plan-node.ts, packages/quereus/src/planner/nodes/bloom-join-node.ts, packages/quereus/test/optimizer/parallel-eager-prefetch-probe.spec.ts
----

## What changed

`EagerPrefetchNode` is a runtime-only FIFO ring-buffer pass-through that never
overrode `computePhysical`, so the default child-merge in `PlanNode.physical`
(`plan-node.ts:540-570`) silently dropped every relational claim. The merge
only carries `deterministic`/`idempotent`/`readonly`/`expectedLatencyMs`/
`concurrencySafe`. The implement stage added a `computePhysical` override
(mirroring `LimitOffsetNode.computePhysical`, `limit-offset.ts:71-85`) that
propagates `estimatedRows`/`ordering`/`fds`/`equivClasses`/`constantBindings`/
`domainConstraints`/`monotonicOn` from `childrenPhysical[0]`, deliberately
omitting the access-path-local `accessCapabilities`/`rangeBoundedOn` (per the
`PhysicalProperties` contract at `plan-node.ts:231-263`). It rewrote the class
docstring and added two regression tests.

This is a missed-optimization defect (never wrong rows — FIFO preserves order),
made live by `ruleEagerPrefetchProbe` wrapping the probe side of a high-latency
hash join.

## Review findings

### Scope checked
Read the implement diff (`a0b36a8c`) before the handoff summary, then audited
the override, the `PhysicalProperties` interface, the default merge in
`PlanNode.physical`, the `LimitOffsetNode` reference pattern, both regression
tests + the `MockRelNode`/`makeAttr` harness, and the downstream consumer
`BloomJoinNode.computePhysical`. Angles considered: correctness, SPP/DRY (mirror
of LimitOffset), field-coverage completeness, the pass-through-must-not-carry
invariant, type safety, docstring accuracy, and whether the fix is dead code.

### Correctness / completeness — **clean, verified**
- **Field coverage is complete.** The relational `PhysicalProperties` fields are
  `ordering`/`estimatedRows`/`fds`/`equivClasses`/`constantBindings`/
  `domainConstraints`/`monotonicOn` (+ access-path-local
  `accessCapabilities`/`rangeBoundedOn`). The override propagates all seven and
  correctly omits the two access-path-local ones, matching the documented
  contract and `LimitOffsetNode`. There is **no separate `keys` field** — keys
  are encoded as FDs (`plan-node.ts:188-189`), so the docstring's "keys pass
  through" is satisfied by `fds`. Nothing was missed.
- **The merge composes correctly.** `physical` does `{...defaults, ...override}`,
  so the override's relational claims layer over the default
  deterministic/idempotent/readonly/latency/concurrency flags — which the
  override correctly does *not* respecify.
- **The fix is not dead code — confirmed real downstream payoff.**
  `BloomJoinNode.computePhysical` (`bloom-join-node.ts:75-107`) reads
  `childrenPhysical[0]` (the probe / EagerPrefetch side) and feeds it into
  `analyzeJoinKeyCoverage` (preservedKeys) and `propagateJoinFds`
  (fds/equivClasses/constantBindings/domainConstraints). Before the fix those
  claims arrived empty from the prefetch, weakening the join's own output claims
  and defeating downstream Distinct/streaming-aggregate elision. (Note:
  BloomJoin itself does not emit `ordering`/`monotonicOn`, so those two fields'
  payoff is only for a non-join consumer reading a prefetch directly; the FD/EC/
  binding family is what feeds the join. The propagation is still correct to
  carry all of them.)

### Implementer-flagged gaps — **two empirically closed in this pass**
- **Full suite not run (their biggest concern):** ran the entire
  `@quereus/quereus` suite — **3427 passing, 9 pending, exit 0**. No plan-shape
  regression from the strengthened claims. (Consistent with the rule being inert
  on memory-vtab plans, so EagerPrefetch nodes are not even created in the
  standard corpus.)
- **"Test fails without the fix" not verified:** empirically confirmed by
  temporarily disabling the override and running the propagation test — it fails
  with exactly `ordering must survive: expected undefined to deeply equal
  [{ column: 0, desc: false }]`, then restored. The working tree is back to the
  committed state.
- **No end-to-end assertion through a real `BloomJoinNode`:** left as-is. The
  propagation mechanism is covered in isolation; the consumer wiring is verified
  by reading `BloomJoinNode.computePhysical` (above) and exercised by the
  3427-test suite. An end-to-end `.physical` assertion on the wrapping join in
  the `joinSQL` scenario would be a nice-to-have, not a defect — **not filed**,
  as the behavior is adequately covered and no regression exists.

### Minor findings → fixed inline
None. The implementation is clean and idiomatic.

### Major findings → new tickets
None.

### Validation performed this pass
- `yarn workspace @quereus/quereus run build` — exit 0.
- Full `@quereus/quereus` `yarn test` — 3427 passing, 9 pending, exit 0.
- `yarn lint` — exit 0.
- Negative check: override disabled → propagation test fails as predicted →
  restored; `git diff --stat` clean.
